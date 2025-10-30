import express from 'express';
import expressWsFactory from 'express-ws';

// Tiny helper for timestamped logs and unique connection ids
function ts() {
  return new Date().toISOString();
}

let connCounter = 0;

const app = express();
const { app: wsApp } = expressWsFactory(app);

// /echo websocket endpoint
wsApp.ws('/echo', function (ws, req) {
  const id = ++connCounter;
  console.log(`${ts()} ✅ Client connected to /echo (conn=${id})`);

  ws.on('message', (msg) => {
    const text = msg.toString();
    console.log(`${ts()} 📩 Received from conn=${id}: ${text}`);
    const reply = `Echo: ${text}`;
    ws.send(reply);
    console.log(`${ts()} 🔁 Sent to conn=${id}: ${reply}`);
  });

  ws.on('close', () => {
    console.log(`${ts()} 🔌 Connection closed (conn=${id})`);
  });
});

const PORT = 3002;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 WebSocket test running on port ${PORT}`);
});

export default server;
