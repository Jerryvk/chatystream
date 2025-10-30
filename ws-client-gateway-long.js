import WebSocket from 'ws';

const url = 'ws://localhost:3002/stream-gateway';

async function run() {
  const ws = new WebSocket(url);
  const start = Date.now();

  ws.on('open', () => {
    console.log('client: open');
    ws.send('ping');
  });

  ws.on('message', (msg) => {
    const latency = Date.now() - start;
    console.log('client: received ->', msg.toString());
    console.log('client: latency ms =', latency);
    // keep connection open to observe heartbeats
  });

  ws.on('close', () => {
    console.log('client: closed');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('client: error', err && err.message ? err.message : err);
    process.exit(2);
  });
}

run();
