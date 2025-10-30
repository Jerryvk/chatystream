import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import dotenv from "dotenv";

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

wsApp.ws('/stream-gateway', (clientWs, req) => {
  const connId = ++connCounter;
  logEvent('client.connected', {}, connId);

  const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_API;
  // Log key prefix per connection as well
  if (OPENAI_KEY) logEvent('security.key.prefix', { prefix: String(OPENAI_KEY).slice(0, 8) }, connId);

  const aiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  logEvent('ai.socket.connecting', { url: aiUrl }, connId);
  const aiSocket = new WebSocket(aiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
  });

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
    logEvent('client.message.received', { bytes, isBinary: !!isBinary }, connId);

    if (aiSocket.readyState === WebSocket.OPEN) {
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

  // Forward AI -> client
  aiSocket.on('message', (msg, isBinary) => {
    lastAiActivity = Date.now();
    const bytes = byteLen(msg);
    logEvent('ai.message.received', { bytes, isBinary: !!isBinary }, connId);

    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg);
        logEvent('client.message.sent', { bytes, isBinary: !!isBinary }, connId);
      } else {
        logEvent('client.closed', { reason: 'client_not_open' }, connId);
      }
    } catch (e) {
      logEvent('client.closed', { message: String(e && e.message ? e.message : e) }, connId);
    }
  });

  aiSocket.on('open', () => {
    logEvent('ai.socket.open', {}, connId);
    // flush pendingMessages FIFO
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

  aiSocket.on('close', (code, reason) => {
    logEvent('ai.socket.closed', { code, reason }, connId);
    // if client open, close it
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    // if pending messages remain, log drop
    if (pendingMessages.length > 0) {
      let droppedBytes = pendingMessages.reduce((s, it) => s + (it.bytes || 0), 0);
      let droppedCount = pendingMessages.length;
      pendingMessages.length = 0;
      pendingBytes = 0;
      logEvent('buffer.drop', { droppedCount, droppedBytes, reason: 'socket_closed' }, connId);
    }
  });

  aiSocket.on('error', (err) => {
    logEvent('ai.socket.error', { message: String(err && err.message ? err.message : err) }, connId);
    try { aiSocket.terminate(); } catch (e) {}
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ error: 'AI_SOCKET_ERROR', message: String(err && err.message ? err.message : err) }));
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

app.listen(PORT, () => {
  logEvent('gateway.start', { port: PORT });
  console.log(`Chatty Stream Gateway active on :${PORT}`);
});

// graceful shutdown
process.on('SIGINT', () => {
  logEvent('gateway.shutdown', {});
  process.exit(0);
});
