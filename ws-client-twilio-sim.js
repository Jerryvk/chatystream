// Tiny simulator for Twilio Media Streams JSON messages: start -> multiple media -> stop
import WebSocket from 'ws';
import fs from 'fs';

const url = 'ws://localhost:3002/stream-gateway';
const ws = new WebSocket(url);

ws.on('open', async () => {
  console.log('sim: open');
  // send start event
  ws.send(JSON.stringify({ event: 'start', streamSid: 'SIM123' }));

  // send a few media frames from a sample ulaw file if exists
  const samplePath = '/var/www/chatystream/sample_ulaw.raw';
  let data = null;
  try { data = fs.readFileSync(samplePath); } catch (e) { data = null; }

  if (data) {
    // split into small chunks
    const chunkSize = 320; // e.g., 20ms at 8k ~ 160 samples -> but u-law bytes
    for (let i = 0; i < Math.min(20, Math.ceil(data.length / chunkSize)); i++) {
      const slice = data.slice(i * chunkSize, i * chunkSize + chunkSize);
      ws.send(JSON.stringify({ event: 'media', media: { payload: slice.toString('base64') } }));
      await new Promise(r => setTimeout(r, 100));
    }
  } else {
    // send dummy payloads
    for (let i = 0; i < 5; i++) {
      const fake = Buffer.alloc(160, 0xFF); // silence-ish ulaw
      ws.send(JSON.stringify({ event: 'media', media: { payload: fake.toString('base64') } }));
      await new Promise(r => setTimeout(r, 100));
    }
  }

  ws.send(JSON.stringify({ event: 'stop', streamSid: 'SIM123' }));
  setTimeout(() => ws.close(), 1000);
});

ws.on('message', (m) => console.log('sim: recv', m.toString()));
ws.on('close', () => { console.log('sim: closed'); process.exit(0); });
