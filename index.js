import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import https from "https";

// ======================
// HTTP-server
// ======================

const server = http.createServer((req, res) => {
  // TwiML endpoint: respond with TwiML XML for Twilio to start Media Stream
  try {
    const method = req.method || 'GET';
    const url = req.url || '/';
    if (url === '/twiml') {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Start>\n    <Stream name="chaty" url="wss://chatystream.chat/stream-gateway" />\n  </Start>\n  <Say>Streaming started.</Say>\n</Response>`;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml);
      // structured log for TwiML request
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'twiml.request', detail: { path: '/twiml', method } }));
      return;
    }
  } catch (err) {
    // fallthrough to not-found
  }

  // default: not found (remove previous plain-text hello response)
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(3000, () => {
  console.log("🌐 HTTP-server draait op poort 3000");
});

// ======================
// HTTPS + WebSocket-server
// ======================

// Zorg dat dit maar één keer draait
if (globalThis.secureServerStarted) {
  console.log("⚠️ HTTPS-server bestaat al — nieuwe aanmaak overgeslagen.");
} else {
  globalThis.secureServerStarted = true;

  console.log("🧠 HTTPS-server wordt aangemaakt op:", new Date().toISOString());

  const secureServer = https.createServer({
    cert: fs.readFileSync("/etc/letsencrypt/live/chatystream.chat/fullchain.pem"),
    key: fs.readFileSync("/etc/letsencrypt/live/chatystream.chat/privkey.pem"),
  });

  const wss = new WebSocketServer({ server: secureServer });

  wss.on("connection", (ws) => {
    console.log("✅ Nieuwe WebSocket-verbinding");
    ws.send("Welkom bij Chatystream WebSocket!");

    ws.on("message", (msg) => {
      console.log("📩 Ontvangen van client:", msg.toString());
      ws.send("echo: " + msg.toString());
    });

    ws.on("close", () => {
      console.log("🔌 Verbinding gesloten door client");
    });
  });

  secureServer.listen(3001, "0.0.0.0", () => {
    console.log("🧠 SecureServer luistert op poort 3001:", new Date().toISOString());
  });
}
