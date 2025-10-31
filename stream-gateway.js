import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import fs from 'fs';
import dotenv from "dotenv";
import OpenAI from "openai";

// Load environment variables from the project's environments directory
dotenv.config({ path: "/var/www/chatystream/environments/.env" });

const app = express();
const { app: wsApp } = expressWs(app);

const PORT = 3002;

function nowTs() {
  return new Date().toISOString();
}

// Helper to log bytes
function byteLen(data) {
  try {
    if (Buffer.isBuffer(data)) return data.length;
    if (typeof data === 'string') return Buffer.byteLength(data);
    return Buffer.byteLength(JSON.stringify(data));
  } catch (e) {
    return 0;
  }
}

function logEvent(event, detail = {}, connId = null) {
  const out = { ts: nowTs(), event, detail };
  if (connId !== null && connId !== undefined) out.connId = connId;
  try {
    console.log(JSON.stringify(out));
  } catch (e) {
    // fallback to plain log
    console.log(JSON.stringify({ ts: nowTs(), event: 'log.error', detail: { message: 'log serialization failed' } }));
  }
}

const MAX_BUFFER_ITEMS = 5000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB

let connCounter = 0;

// Log gateway start and security key prefix
logEvent('gateway.start', { port: PORT });
const startupKey = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_API || null;
if (startupKey) {
  logEvent('security.key.prefix', { prefix: String(startupKey).slice(0, 8) });
}

// Initialize OpenAI client once using environment key
const OPENAI_RUNTIME_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_API || null;
const openai = OPENAI_RUNTIME_KEY ? new OpenAI({ apiKey: OPENAI_RUNTIME_KEY }) : null;

// mu-law (u-law) decode table generator
function ulawToPcm16(uVal) {
  // u-law to linear PCM conversion
  const u = ~uVal & 0xff;
  const t = ((u & 0x0f) << 3) + 0x84;
  const seg = (u & 0x70) >> 4;
  let pcm = t << seg;
  pcm = (pcm - 0x84);
  return (u & 0x80) ? -pcm : pcm;
}

function decodeMuLawBuffer(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const pcm = ulawToPcm16(buf[i]);
    out.writeInt16LE(pcm, i * 2);
  }
  return out;
}

function wavBufferFromPcm16LE(pcmBuffer, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const dataLen = pcmBuffer.length;
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24); // sample rate
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (sampleRate * blockAlign)
  header.writeUInt16LE(2, 32); // block align (channels * bytesPerSample)
  header.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// Upsample from 8k PCM16LE to 16k PCM16LE by simple linear interpolation (or duplication)
function upsample8kTo16k(pcm8k) {
  // pcm8k is Buffer of int16 LE samples
  const samples = pcm8k.length / 2;
  const out = Buffer.alloc(samples * 2 * 2); // double samples
  for (let i = 0; i < samples; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    // simple duplicate (nearest neighbor) to double sample rate
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

// Transcribe a Buffer (WAV or audio) using OpenAI's Whisper endpoint asynchronously
async function transcribeBufferWithRetry(connId, wavBuffer) {
  if (!openai) {
    logEvent('whisper.error', { message: 'OpenAI client not initialized' }, connId);
    return null;
  }

  // create a readable stream from buffer
  const { Readable } = await import('stream');
  const stream = new Readable();
  stream.push(wavBuffer);
  stream.push(null);

  const attempt = async () => {
    try {
      // Use the OpenAI SDK audio transcription endpoint
      const resp = await openai.audio.transcriptions.create({ file: stream, model: 'whisper-1' });
      return resp;
    } catch (e) {
      throw e;
    }
  };

  try {
    const res = await attempt();
    return res;
  } catch (err) {
    // retry once
    logEvent('whisper.retry', { message: 'retrying once after failure' }, connId);
    try {
      const res2 = await attempt();
      return res2;
    } catch (err2) {
      logEvent('whisper.error', { message: String(err2 && err2.message ? err2.message : err2) }, connId);
      return null;
    }
  }
}

wsApp.ws('/stream-gateway', (clientWs, req) => {
  const connId = ++connCounter;
  logEvent('client.connected', {}, connId);

  const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_API;
  // Log key prefix per connection as well
  if (OPENAI_KEY) logEvent('security.key.prefix', { prefix: String(OPENAI_KEY).slice(0, 8) }, connId);

  const aiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

  // AI socket and reconnect state
  let aiSocket = null;
  let aiRetries = 0;
  const AI_MAX_RETRIES = 6;
  const AI_HANDSHAKE_TIMEOUT = 12000; // 12s

  // Track whether we've sent any audio since last commit; used by periodic committer
  let pendingAudioSinceLastCommit = false;
  // Track if we received any transcript output (used to mark checkpoint on stream end)
  let sawTranscriptOutput = false;
  // Accumulate speech frames (PCM16 Buffer objects) to batch before commit
  let pendingFrames = [];

  function scheduleAiConnect(delay = 0) {
    setTimeout(() => connectToAi(), delay);
  }

  function connectToAi() {
    const url = aiUrl;
    logEvent('ai.socket.connecting', { url, attempt: aiRetries + 1 }, connId);

    const headers = {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    };

    aiSocket = new WebSocket(url, { headers, handshakeTimeout: AI_HANDSHAKE_TIMEOUT });

    // Connection timeout guard (in case handshake stalls)
    const connectTimer = setTimeout(() => {
      logEvent('ai.socket.connect.timeout', { timeoutMs: AI_HANDSHAKE_TIMEOUT }, connId);
      try { aiSocket.terminate(); } catch (e) {}
    }, AI_HANDSHAKE_TIMEOUT + 2000);

    aiSocket.on('open', () => {
      clearTimeout(connectTimer);
      aiRetries = 0;
      logEvent('ai.socket.open', { url }, connId);
      // Human-friendly log for PM2/tests
      console.log(`[${nowTs()}] connected to OpenAI Realtime`);

      // flush pendingMessages FIFO (existing logic)
      let flushedCount = 0;
      let flushedBytes = 0;
      const now = Date.now();
      while (pendingMessages.length > 0) {
        const item = pendingMessages.shift();
        if (!item) continue;
        const age = now - item.ts;
        if (age > 30000) {
          // expired
          logEvent('buffer.expired', { bytes: item.bytes, age }, connId);
          pendingBytes -= item.bytes || 0;
          continue;
        }
        try {
          aiSocket.send(item.payload);
          flushedCount += 1;
          flushedBytes += item.bytes || 0;
          pendingBytes -= item.bytes || 0;
        } catch (e) {
          logEvent('ai.socket.error', { message: String(e && e.message ? e.message : e) }, connId);
        }
      }
      if (flushedCount > 0) logEvent('buffer.flushed', { flushedCount, flushedBytes }, connId);
    });

    // Unexpected-response gives access to HTTP status codes (e.g., 401/403)
    aiSocket.on('unexpected-response', (req, res) => {
      try {
        const code = res && res.statusCode;
        logEvent('ai.socket.unexpected_response', { statusCode: code }, connId);
        if (code === 401 || code === 403) {
          // auth problem: retry with backoff (do not infinite loop)
          if (aiRetries < AI_MAX_RETRIES) {
            aiRetries++;
            const backoff = Math.pow(2, aiRetries) * 1000;
            logEvent('ai.socket.auth_retry', { attempt: aiRetries, backoff }, connId);
            try { aiSocket.terminate(); } catch (e) {}
            scheduleAiConnect(backoff);
          } else {
            logEvent('ai.socket.auth_failed', { attempts: aiRetries }, connId);
          }
        }
      } catch (e) {
        logEvent('ai.socket.unexpected_response.error', { message: String(e && e.message ? e.message : e) }, connId);
      }
    });

    // Forward AI -> client: handle incoming realtime events and print partial transcripts
    aiSocket.on('message', (msg, isBinary) => {
      lastAiActivity = Date.now();
      const bytes = byteLen(msg);
      logEvent('ai.message.received', { bytes, isBinary: !!isBinary }, connId);

      // Try to parse AI message as JSON and log
      let parsedAi = null;
      try {
        const txt = typeof msg === 'string' ? msg : msg.toString();
        parsedAi = JSON.parse(txt);
      } catch (e) {
        parsedAi = null;
      }

      // Log the raw event for debugging/inspection
      try {
        logEvent('openai.event', { raw: parsedAi || msg }, connId);
      } catch (e) {
        // ignore logging serialization failures
      }

      // Print partial transcript when OpenAI returns response.output_text.delta
      try {
        if (parsedAi && parsedAi.type === 'response.output_text.delta') {
          const deltaText = parsedAi.delta && (parsedAi.delta.content || parsedAi.delta) ? (parsedAi.delta.content || parsedAi.delta) : (parsedAi.text || '');
          if (deltaText) {
            // Explicit transcript console line as requested
            try {
              const maybeDelta = typeof parsedAi.delta !== 'undefined' ? parsedAi.delta : parsedAi.text;
              console.log(`[${nowTs()}] OpenAI transcript: ${JSON.stringify(maybeDelta)}`);
            } catch (e) {
              console.log(`[${nowTs()}] OpenAI transcript: ${deltaText}`);
            }
            logEvent('openai.transcript.delta', { text: deltaText }, connId);
            sawTranscriptOutput = true;
          }
        }

        // Backwards/compat: older events called transcript.delta
        if (parsedAi && parsedAi.type === 'transcript.delta') {
          const text = parsedAi.text || (parsedAi.delta && parsedAi.delta.text) || '';
          console.log(`[${nowTs()}] OpenAI transcript: ${JSON.stringify(parsedAi.delta || text)}`);
          logEvent('openai.transcript.delta', { text }, connId);
          sawTranscriptOutput = true;
        }
      } catch (e) {
        logEvent('openai.event.parse_error', { message: String(e && e.message ? e.message : e) }, connId);
      }

      // Forward to connected client if present
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(msg);
          logEvent('client.message.sent', { bytes, isBinary: !!isBinary }, connId);
        }
      } catch (e) {
        logEvent('client.forward.error', { message: String(e && e.message ? e.message : e) }, connId);
      }
    });

    aiSocket.on('error', (err) => {
      logEvent('ai.socket.error', { message: String(err && err.message ? err.message : err) }, connId);
      // Terminate and schedule retry
      try { aiSocket.terminate(); } catch (e) {}
      if (aiRetries < AI_MAX_RETRIES) {
        aiRetries++;
        const backoff = Math.pow(2, aiRetries) * 1000;
        logEvent('ai.socket.retry_scheduled', { attempt: aiRetries, backoff }, connId);
        scheduleAiConnect(backoff);
      } else {
        logEvent('ai.socket.retries_exhausted', { attempts: aiRetries }, connId);
      }
    });

    aiSocket.on('close', (code, reason) => {
      logEvent('ai.socket.closed', { code, reason: reason && reason.toString ? reason.toString() : reason }, connId);
      // schedule reconnect for transient failures
      if (code === 1006 || code === 1011 || code === 1001) {
        if (aiRetries < AI_MAX_RETRIES) {
          aiRetries++;
          const backoff = Math.pow(2, aiRetries) * 1000;
          logEvent('ai.socket.closed.retry', { attempt: aiRetries, backoff }, connId);
          scheduleAiConnect(backoff);
        } else {
          logEvent('ai.socket.closed.no_more_retries', { attempts: aiRetries }, connId);
        }
      }
      // if client open, keep client connected; other cleanup handled on client close
    });

    // aiSocket.on('message') handler will be attached below (re-usable reference)
  }

  // Start initial connect
  connectToAi();

  // Periodic committer: every ~1s, if we've appended any audio since last commit, commit and request a response.
  const COMMIT_INTERVAL_MS = 1000;
  const commitTimer = setInterval(() => {
    try {
      // If we have queued frames, batch them into a single append before committing
      if (pendingFrames.length > 0) {
        console.log(`[${nowTs()}] batching ${pendingFrames.length} frames before commit`);
        const combined = Buffer.concat(pendingFrames);
        const audioB64 = combined.toString('base64');
        const appendMsg = JSON.stringify({ type: 'input_audio_buffer.append', audio: audioB64 });

        if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
          aiSocket.send(appendMsg);
          console.log(`[${nowTs()}] sent combined input_audio_buffer.append (${pendingFrames.length} frames, ${combined.length} bytes)`);
          logEvent('openai.audio.sent', { combinedFrames: pendingFrames.length, bytes: combined.length }, connId);
        } else {
          // Buffer the combined append for flushing later
          bufferStore({ ts: Date.now(), bytes: combined.length, isBinary: false, payload: appendMsg });
          logEvent('openai.audio.buffered_combined', { combinedFrames: pendingFrames.length, bytes: combined.length }, connId);
        }

        // After sending/appending, commit and create a response
  const commitMsg = JSON.stringify({ type: 'input_audio_buffer.commit' });
  const createMsg = JSON.stringify({ type: 'response.create', response: { modalities: ['text'], instructions: 'transcribe the audio in Dutch' } });
        console.log(`[${nowTs()}] sending input_audio_buffer.commit`);
        if (aiSocket && aiSocket.readyState === WebSocket.OPEN) aiSocket.send(commitMsg);
        console.log(`[${nowTs()}] sending response.create (transcribe)`);
        if (aiSocket && aiSocket.readyState === WebSocket.OPEN) aiSocket.send(createMsg);
        logEvent('openai.commit.sent', { commitBytes: combined.length, frames: pendingFrames.length }, connId);

        // clear pending frames
        pendingFrames.length = 0;
        pendingAudioSinceLastCommit = false;
      }
    } catch (e) {
      logEvent('openai.commit.error', { message: String(e && e.message ? e.message : e) }, connId);
    }
  }, COMMIT_INTERVAL_MS);

  let lastClientActivity = Date.now();
  let lastAiActivity = Date.now();

  const hbInterval = 10000; // 10s
  const inactiveLimit = 30000; // 30s

  // Buffer for messages received before AI socket opens
  const pendingMessages = [];
  let pendingBytes = 0;

  function bufferStore(item) {
    // item = { ts, bytes, isBinary, payload }
    pendingMessages.push(item);
    pendingBytes += item.bytes || 0;
    logEvent('buffer.stored', { bytes: item.bytes, isBinary: !!item.isBinary, buffered: true }, connId);

    // enforce limits
    let droppedCount = 0;
    let droppedBytes = 0;
    while (pendingMessages.length > MAX_BUFFER_ITEMS || pendingBytes > MAX_BUFFER_BYTES) {
      const dropped = pendingMessages.shift();
      if (dropped) {
        droppedCount += 1;
        droppedBytes += dropped.bytes || 0;
        pendingBytes -= dropped.bytes || 0;
      }
    }
    if (droppedCount > 0) {
      logEvent('buffer.drop', { droppedCount, droppedBytes, reason: 'limits_exceeded' }, connId);
    }
  }

  // Forward client -> AI (with buffering)
  clientWs.on('message', (msg, isBinary) => {
    lastClientActivity = Date.now();
    const bytes = byteLen(msg);
    // Attempt to parse Twilio media JSON; if it's Twilio formatted, handle separately
    let parsed = null;
    try {
      parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
    } catch (e) {
      parsed = null;
    }

    // If Twilio Media Stream JSON
    if (parsed && parsed.event) {
      // Diagnostic: log every incoming Twilio event with timestamp and basic payload info
      try {
        const ev = parsed.event;
        // For start, show which keys arrived (useful to see streamSid/accountSid)
        if (ev === 'start') {
          const keys = Object.keys(parsed || {});
          console.log(`[${nowTs()}] event:start keys=${JSON.stringify(keys)}`);
        } else if (ev === 'media') {
          const payloadB64 = parsed.media && parsed.media.payload;
          if (payloadB64) {
            // compute decoded byte length without altering later flow
            const decodedLen = Buffer.from(payloadB64, 'base64').length;
            console.log(`[${nowTs()}] event:media payload=${decodedLen} bytes`);
          } else {
            console.log(`[${nowTs()}] event:media payload=0 bytes`);
          }
        } else if (ev === 'stop') {
          console.log(`[${nowTs()}] event:stop`);
        } else if (ev === 'mark') {
          console.log(`[${nowTs()}] event:mark keys=${JSON.stringify(Object.keys(parsed || {}))}`);
        } else {
          console.log(`[${nowTs()}] event:${String(ev)} keys=${JSON.stringify(Object.keys(parsed || {}))}`);
        }
      } catch (e) {
        // non-fatal diagnostic failure
        logEvent('twilio.diagnostic.error', { message: String(e && e.message ? e.message : e) }, connId);
      }

      // Twilio flow: start, media, stop, mark
      if (parsed.event === 'start') {
        logEvent('twilio.start', { sid: parsed.streamSid || parsed.session }, connId);
        // human-friendly log for checklist
        console.log(`[${nowTs()}] Twilio connected`);
        // initialize per-connection audio state (kept minimal for future steps)
        clientWs._twilio = clientWs._twilio || { seen: true };
      } else if (parsed.event === 'media') {
        // payload is base64 in parsed.media.payload
        const payloadB64 = parsed.media && parsed.media.payload;
        if (payloadB64) {
          try {
            // Decode base64 first
            const raw = Buffer.from(payloadB64, 'base64');

            // Twilio may send either raw PCM16LE (audio/pcm) or mu-law 8-bit samples.
            // Prefer PCM16LE when payload length is even and looks like int16 samples.
            let pcm16Buffer = null;
            if (raw.length % 2 === 0) {
              // Treat as PCM16LE
              pcm16Buffer = raw;
            } else {
              // Fallback to mu-law decode for odd-length buffers
              pcm16Buffer = decodeMuLawBuffer(raw);
            }

            // Compute RMS over int16 samples
            const sampleCount = Math.floor(pcm16Buffer.length / 2);
            let sumSq = 0;
            for (let i = 0; i < sampleCount; i++) {
              const s = pcm16Buffer.readInt16LE(i * 2);
              sumSq += s * s;
            }
            const meanSq = sampleCount > 0 ? (sumSq / sampleCount) : 0;
            const rms = Math.sqrt(meanSq) / 32768; // normalize to [0,1]

            // Log in a human-friendly single-line format for easy grepping during tests
            console.log(`[${nowTs()}] frames: ${pcm16Buffer.length} bytes, rms: ${rms.toFixed(4)}`);

            // Also emit structured event for diagnostics
            logEvent('twilio.media', { bytes: raw.length, pcmBytes: pcm16Buffer.length, rms }, connId);

            // Forward PCM16 audio to OpenAI Realtime WebSocket as base64-encoded messages
            try {
              // Only queue audio frames when RMS indicates speech (> 0.1). Otherwise skip silence.
              if (rms > 0.1) {
                pendingAudioSinceLastCommit = true;
                // store the PCM16 Buffer locally for batching
                pendingFrames.push(pcm16Buffer);
                logEvent('openai.audio.queued', { bytes: pcm16Buffer.length, rms, pendingFrames: pendingFrames.length }, connId);
              } else {
                // silence — skip queuing
                logEvent('openai.audio.skip_silence', { bytes: pcm16Buffer.length, rms }, connId);
              }
            } catch (e) {
              logEvent('openai.forward.error', { message: String(e && e.message ? e.message : e) }, connId);
            }
          } catch (e) {
            logEvent('twilio.error', { message: String(e && e.message ? e.message : e) }, connId);
          }
        }
      } else if (parsed.event === 'stop') {
        logEvent('twilio.stop', { sid: parsed.streamSid }, connId);
        // human-friendly log for checklist
        console.log(`[${nowTs()}] Stream ended`);

        // If there's pending audio that hasn't been committed yet, try to commit it now
        try {
          if (pendingFrames.length > 0) {
            console.log(`[${nowTs()}] batching ${pendingFrames.length} frames before commit (on stop)`);
            const combined = Buffer.concat(pendingFrames);
            const audioB64 = combined.toString('base64');
            const appendMsg = JSON.stringify({ type: 'input_audio_buffer.append', audio: audioB64 });

            if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
              aiSocket.send(appendMsg);
              console.log(`[${nowTs()}] sent combined input_audio_buffer.append (${pendingFrames.length} frames, ${combined.length} bytes) (on stop)`);
              logEvent('openai.audio.sent', { combinedFrames: pendingFrames.length, bytes: combined.length }, connId);
            } else {
              bufferStore({ ts: Date.now(), bytes: combined.length, isBinary: false, payload: appendMsg });
              logEvent('openai.audio.buffered_combined', { combinedFrames: pendingFrames.length, bytes: combined.length }, connId);
            }

            const commitMsg = JSON.stringify({ type: 'input_audio_buffer.commit' });
            const createMsg = JSON.stringify({ type: 'response.create', response: { modalities: ['text'], instructions: 'transcribe the audio in Dutch' } });
            try {
              console.log(`[${nowTs()}] sending input_audio_buffer.commit (on stop)`);
              if (aiSocket && aiSocket.readyState === WebSocket.OPEN) aiSocket.send(commitMsg);
              console.log(`[${nowTs()}] sending response.create (transcribe) (on stop)`);
              if (aiSocket && aiSocket.readyState === WebSocket.OPEN) aiSocket.send(createMsg);
              logEvent('openai.commit.sent.on_stop', { bytes: combined.length, frames: pendingFrames.length }, connId);
            } catch (e) {
              logEvent('openai.commit.on_stop.error', { message: String(e && e.message ? e.message : e) }, connId);
            }

            pendingFrames.length = 0;
            pendingAudioSinceLastCommit = false;
          }
        } catch (e) {
          logEvent('openai.commit.on_stop.error', { message: String(e && e.message ? e.message : e) }, connId);
        }

        // Mark checkpoint if we received transcript output
        try {
          if (sawTranscriptOutput) {
            const ck = `2.2 Completed — Audio Forwarded and Transcribed - ${new Date().toISOString()}\n`;
            try { fs.appendFileSync('/var/www/chatystream/.checkpoints', ck); } catch (e) { /* best-effort */ }
            logEvent('checkpoint.2.2.marked', { note: '2.2 Completed — Audio Forwarded and Transcribed' }, connId);
          }

        } catch (e) {
          logEvent('checkpoint.error', { message: String(e && e.message ? e.message : e) }, connId);
        }

        // clear any minimal state we kept
        if (clientWs._twilio) clientWs._twilio = null;
      }
      // Twilio messages are handled above; do not further forward raw JSON to AI
      return;
    }

    logEvent('client.message.received', { bytes, isBinary: !!isBinary }, connId);

  if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
      try {
        aiSocket.send(msg);
        logEvent('ai.message.sent', { bytes, isBinary: !!isBinary }, connId);
      } catch (e) {
        logEvent('ai.socket.error', { message: String(e && e.message ? e.message : e) }, connId);
      }
    } else {
      // store in buffer
      bufferStore({ ts: Date.now(), bytes, isBinary: !!isBinary, payload: msg });
      logEvent('client.message.sent', { bytes, buffered: true }, connId);
    }
  });

  

  clientWs.on('close', (code, reason) => {
    logEvent('client.closed', { code, reason }, connId);
    try { aiSocket.close(); } catch (e) {}
    if (pendingMessages.length > 0) {
      let droppedBytes = pendingMessages.reduce((s, it) => s + (it.bytes || 0), 0);
      let droppedCount = pendingMessages.length;
      pendingMessages.length = 0;
      pendingBytes = 0;
      logEvent('buffer.drop', { droppedCount, droppedBytes, reason: 'client_closed' }, connId);
    }
    clearInterval(heartbeatTimer);
    try { clearInterval(commitTimer); } catch (e) {}
  });

  clientWs.on('error', (err) => {
    logEvent('client.error', { message: String(err && err.message ? err.message : err) }, connId);
    try { clientWs.terminate(); } catch (e) {}
    try { aiSocket.terminate(); } catch (e) {}
    if (pendingMessages.length > 0) {
      let droppedBytes = pendingMessages.reduce((s, it) => s + (it.bytes || 0), 0);
      let droppedCount = pendingMessages.length;
      pendingMessages.length = 0;
      pendingBytes = 0;
      logEvent('buffer.drop', { droppedCount, droppedBytes, reason: 'client_error' }, connId);
    }
    clearInterval(heartbeatTimer);
    try { clearInterval(commitTimer); } catch (e) {}
  });

  // Heartbeat: ping AI and client every 10s; close if no activity for 30s
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    try {
      if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
        logEvent('heartbeat.ping', { target: 'ai' }, connId);
        aiSocket.ping();
      }
    } catch (e) {
      logEvent('heartbeat.error', { target: 'ai', message: String(e && e.message ? e.message : e) }, connId);
    }

    try {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        logEvent('heartbeat.ping', { target: 'client' }, connId);
        clientWs.send(JSON.stringify({ type: 'ping', ts: now }));
      }
    } catch (e) {
      logEvent('heartbeat.error', { target: 'client', message: String(e && e.message ? e.message : e) }, connId);
    }

    if (now - lastAiActivity > inactiveLimit || now - lastClientActivity > inactiveLimit) {
      logEvent('heartbeat.timeout', { inactiveLimit }, connId);
      try { aiSocket.close(); } catch (e) {}
      try { clientWs.close(); } catch (e) {}
      clearInterval(heartbeatTimer);
    }
  }, hbInterval);
});

// TwiML endpoint to instruct Twilio to start Media Stream
app.post('/twiml', express.urlencoded({ extended: false }), (req, res) => {
  logEvent('twiml.request', { path: '/twiml' });
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Start>\n    <Stream name="chatty" url="wss://chatystream.chat/stream-gateway" />\n  </Start>\n  <Say>Streaming started.</Say>\n</Response>`;
  res.type('text/xml').send(twiml);
});

app.listen(PORT, () => {
  logEvent('gateway.start', { port: PORT });
  // Human-friendly confirmation
  console.log('Chatty Stream Gateway active on :' + PORT);
  console.log('✅ TwiML endpoint active — Twilio can now stream live audio to the gateway.');
});

// graceful shutdown
process.on('SIGINT', () => {
  logEvent('gateway.shutdown', {});
  process.exit(0);
});
