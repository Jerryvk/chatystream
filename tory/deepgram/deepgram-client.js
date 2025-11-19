import { WebSocket } from "ws";
import { EventEmitter } from "events";

/**
 * DeepgramClient - ESM-based WebSocket client for Deepgram real-time transcription
 * Accepts PCM16LE audio chunks and emits final transcript strings
 */
export default class DeepgramClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.apiKey = process.env.DEEPGRAM_API_KEY;
  }

  /**
   * Connect to Deepgram's real-time streaming API
   * @returns {Promise<void>}
   */
  async connect() {
    if (!this.apiKey) {
      throw new Error("[DeepgramClient] DEEPGRAM_API_KEY not found in environment");
    }

    return new Promise((resolve, reject) => {
      try {
        // Deepgram WebSocket URL with streaming parameters
        const url = "wss://api.deepgram.com/v1/listen?" + new URLSearchParams({
          encoding: "linear16",
          sample_rate: "16000",
          channels: "1",
          interim_results: "true",
          punctuate: "true",
          smart_format: "true",
          model: "nova-2",
          language: "en-US"
        });

        this.ws = new WebSocket(url, {
          headers: {
            Authorization: `Token ${this.apiKey}`,
          },
        });

        this.ws.on("open", () => {
          console.log("[DeepgramClient] ✅ Connected to Deepgram");
          this.isConnected = true;
          resolve();
        });

        this.ws.on("message", (data) => {
          try {
            const response = JSON.parse(data.toString());
            
            // Handle transcript messages
            if (response.type === "Results") {
              const transcript = response.channel?.alternatives?.[0]?.transcript;
              const isFinal = response.is_final;

              if (transcript && transcript.trim().length > 0) {
                if (isFinal) {
                  console.log("[DeepgramClient] 📝 Final:", transcript);
                  this.emit("transcript", transcript);
                } else {
                  console.log("[DeepgramClient] 💬 Partial:", transcript);
                  this.emit("partial", transcript);
                }
              }
            } else if (response.type === "Metadata") {
              console.log("[DeepgramClient] ℹ️ Metadata received");
            }
          } catch (err) {
            console.error("[DeepgramClient] ❌ Error parsing message:", err.message);
          }
        });

        this.ws.on("error", (err) => {
          console.error("[DeepgramClient] ❌ WebSocket error:", err.message);
          this.isConnected = false;
          this.emit("error", err);
          reject(err);
        });

        this.ws.on("close", (code, reason) => {
          console.log(`[DeepgramClient] 🔌 Disconnected (${code}): ${reason}`);
          this.isConnected = false;
          this.emit("close");
        });

      } catch (err) {
        console.error("[DeepgramClient] ❌ Connection failed:", err.message);
        reject(err);
      }
    });
  }

  /**
   * Send PCM16LE audio chunk to Deepgram
   * @param {Buffer} audioChunk - Raw PCM audio data
   */
  sendAudio(audioChunk) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[DeepgramClient] ⚠️ Cannot send audio: not connected");
      return false;
    }

    try {
      this.ws.send(audioChunk);
      return true;
    } catch (err) {
      console.error("[DeepgramClient] ❌ Error sending audio:", err.message);
      return false;
    }
  }

  /**
   * Close the connection to Deepgram
   */
  disconnect() {
    if (this.ws) {
      console.log("[DeepgramClient] Closing connection...");
      
      // Send close frame to Deepgram
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch (err) {
        // Ignore errors on close
      }

      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}
