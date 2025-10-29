import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import https from "https";

// ======================
// HTTP-server
// ======================

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello from Chatystream backend!");
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
