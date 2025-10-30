import WebSocket from 'ws';

const url = 'ws://localhost:3002/echo';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('client: open');
  ws.send('hello');
});

ws.on('message', (msg) => {
  console.log('client: received ->', msg.toString());
  ws.close();
});

ws.on('close', () => {
  console.log('client: closed');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('client: error', err && err.message ? err.message : err);
  process.exit(2);
});
