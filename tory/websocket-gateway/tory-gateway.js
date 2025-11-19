// Load environment variables first (ESM style)
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from tory root directory
config({ path: join(__dirname, "../.env") });

import express from "express";
import expressWs from "express-ws";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

// Verify environment variables loaded
console.log("[Tory] Loaded DEEPGRAM key?", !!process.env.DEEPGRAM_API_KEY);
console.log("[Tory] Deepgram API key:", process.env.DEEPGRAM_API_KEY?.slice(0, 4) + "...");

// Initialize Deepgram client using official SDK
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let deepgramLive = null;
let deepgramReady = false;

// Store active client connections
const activeClients = new Map();

// Helper to send messages to all active clients
function broadcastToClients(message) {
  const payload = JSON.stringify(message);
  console.log(`[Broadcast] Sending to ${activeClients.size} clients:`, message.type, message.text?.substring(0, 30));
  activeClients.forEach((client, connId) => {
    try {
      if (client.readyState === 1) { // OPEN
        client.send(payload);
        console.log(`[Broadcast] ✅ Sent to client ${connId}`);
      } else {
        console.log(`[Broadcast] ⚠️ Client ${connId} not ready (state: ${client.readyState})`);
      }
    } catch (err) {
      console.error(`[Tory] Failed to send to client ${connId}:`, err.message);
    }
  });
}

// Function to create Deepgram connection
async function connectDeepgram() {
  try {
    deepgramReady = false;
    
    deepgramLive = deepgramClient.listen.live({
      model: "nova-2",
      language: "nl",  // Dutch
      smart_format: true,
      punctuate: true,
      interim_results: true,
      encoding: "linear16",
      sample_rate: 48000,  // Try browser's native rate
      channels: 1,
      endpointing: 300
    });

    deepgramLive.on(LiveTranscriptionEvents.Open, () => {
      console.log("[Tory] ✅ Deepgram connection opened");
      deepgramReady = true;
    });

    deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;
      
      console.log("[Tory] 📥 Received from Deepgram:", { transcript, isFinal });
      
      if (transcript && transcript.trim().length > 0) {
        if (isFinal) {
          console.log("[Tory] 📝 FINAL TRANSCRIPT:", transcript);
          broadcastToClients({ type: "transcript", text: transcript, isFinal: true });
        } else {
          console.log("[Tory] 💬 PARTIAL TRANSCRIPT:", transcript);
          broadcastToClients({ type: "transcript", text: transcript, isFinal: false });
        }
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("[Tory] 📊 Deepgram metadata received");
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (error) => {
      console.error("[Tory] ❌ Deepgram error:", error);
      deepgramReady = false;
    });

    deepgramLive.on(LiveTranscriptionEvents.Close, () => {
      console.log("[Tory] 🔌 Deepgram connection closed");
      deepgramReady = false;
      
      // Reconnect after 2 seconds
      setTimeout(() => {
        console.log("[Tory] Reconnecting to Deepgram...");
        connectDeepgram();
      }, 2000);
    });

    deepgramLive.on(LiveTranscriptionEvents.Warning, (warning) => {
      console.warn("[Tory] ⚠️ Deepgram warning:", warning);
    });

    console.log("[Tory] Deepgram live transcription initialized");
  } catch (err) {
    console.error("[Tory] ❌ Failed to connect to Deepgram:", err);
  }
}

// Connect to Deepgram
connectDeepgram();

const app = express();
const { app: wsApp } = expressWs(app);

const PORT = 8081;

// --- Logging helpers ---
function nowTs() {
  return new Date().toISOString();
}

function logEvent(event, detail = {}) {
  console.log(JSON.stringify({ ts: nowTs(), event, detail }));
}

// --- WebSocket setup ---
let connCounter = 0;
logEvent("tory.gateway.start", { port: PORT });

// Each browser client connects here
wsApp.ws("/ws", (client, req) => {
  const connId = ++connCounter;
  logEvent("client.connected", { connId });
  
  // Store this client
  activeClients.set(connId, client);

  let lastClientActivity = Date.now();
  const hbInterval = 10000; // ping every 10s
  const inactiveLimit = 30000; // close after 30s idle

  // When browser sends audio chunks
  client.on("message", (msg, isBinary) => {
    lastClientActivity = Date.now();
    const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(msg);
    
    // express-ws doesn't always set isBinary, so detect it ourselves
    const actuallyBinary = Buffer.isBuffer(msg) || msg instanceof ArrayBuffer || msg instanceof Uint8Array;
    
    logEvent("client.message", { connId, bytes: size, isBinary: actuallyBinary });

    // Calculate RMS for audio level monitoring
    const rms = (() => {
      try {
        const data = new Int16Array(msg.buffer, msg.byteOffset, msg.byteLength / 2);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Math.sqrt(sum / data.length) / 32768;
      } catch (err) {
        return 0;
      }
    })();
    console.log(`[🔊] Audio chunk received: ${msg.length} bytes | RMS: ${rms.toFixed(3)}`);

    // Forward audio to Deepgram for transcription
    if (actuallyBinary && Buffer.isBuffer(msg) && deepgramLive && deepgramReady) {
      try {
        // Log first audio chunk details for debugging
        if (!client.audioLogged && rms > 0.05) {
          const int16View = new Int16Array(msg.buffer, msg.byteOffset, Math.min(20, msg.length / 2));
          console.log(`[DEBUG] First REAL audio chunk (RMS=${rms.toFixed(3)}): ${msg.length} bytes`);
          console.log(`[DEBUG] First 10 samples:`, Array.from(int16View.slice(0, 10)));
          console.log(`[DEBUG] Sample range: min=${Math.min(...int16View)}, max=${Math.max(...int16View)}`);
          console.log(`[DEBUG] Bytes (hex):`, msg.slice(0, 40).toString('hex'));
          client.audioLogged = true;
        }
        
        deepgramLive.send(msg);
        // Only log occasionally to reduce spam
        if (Math.random() < 0.05) {
          console.log(`[Tory] ✅ Sending audio to Deepgram (${msg.length} bytes)`);
        }
      } catch (err) {
        console.error("[Tory] ⚠️ Failed to send audio to Deepgram:", err.message);
      }
    } else {
      if (!deepgramReady) {
        console.error("[Tory] ⚠️ Deepgram not ready yet");
      }
    }

    // Echo back acknowledgment
    client.send(JSON.stringify({
      type: "ack",
      ts: nowTs(),
      info: `Received ${size} bytes from client ${connId}`
    }));
  });

  client.on("close", () => {
    logEvent("client.closed", { connId });
    activeClients.delete(connId);
    clearInterval(heartbeat);
  });

  client.on("error", (err) => {
    logEvent("client.error", { connId, message: err.message });
    activeClients.delete(connId);
    try { client.terminate(); } catch {}
    clearInterval(heartbeat);
  });

  // --- Heartbeat ---
  const heartbeat = setInterval(() => {
    const now = Date.now();
    try {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "ping", ts: now }));
      }
    } catch (e) {
      logEvent("heartbeat.error", { connId, message: e.message });
    }

    if (now - lastClientActivity > inactiveLimit) {
      logEvent("heartbeat.timeout", { connId });
      try { client.close(); } catch {}
      clearInterval(heartbeat);
    }
  }, hbInterval);
});

app.listen(PORT, () => {
  console.log(`✅ Tory WebSocket Gateway active on port ${PORT}`);
});
