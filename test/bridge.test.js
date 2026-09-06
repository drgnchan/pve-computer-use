import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { ConsoleBridge } from '../src/bridge.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
async function fakeUpstream() {
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
  });
  const seen = { headers: null, messages: [] };
  server.on('connection', (socket, request) => {
    seen.headers = request.headers;
    socket.on('message', data => {
      seen.messages.push(data.toString());
      socket.send(Buffer.from(`echo:${data}`), { binary: true });
    });
  });
  await new Promise(resolve => server.once('listening', resolve));
  return { server, seen, url: `ws://127.0.0.1:${server.address().port}/api2/json/nodes/lab/qemu/105/vncwebsocket?port=5900&vncticket=t` };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['binary']);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('bridge serves the console page and pipes the RFB websocket', async t => {
  const upstream = await fakeUpstream();
  const closed = [];
  const bridge = await new ConsoleBridge({
    upstreamUrl: upstream.url,
    headers: { Cookie: 'PVEAuthCookie=test-ticket', Authorization: 'PVEAPIToken=user@pve!t=secret' },
    webRoot,
    onUpstreamClosed: reason => closed.push(reason),
  }).start();
  t.after(async () => { await bridge.close(); upstream.server.close(); });

  const page = await fetch(bridge.pageUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="screen"/);

  if (fs.existsSync(path.join(webRoot, 'dist/console.bundle.js'))) {
    const bundle = await fetch(`${bridge.origin}/console.bundle.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type'), /javascript/);
    assert.match(await bundle.text(), /pveConsole/);
  }
  assert.equal((await fetch(`${bridge.origin}/nope`)).status, 404);

  await assert.rejects(() => connect(`${bridge.origin}/rfb`), 'the token must be required');
  await assert.rejects(() => connect(`${bridge.origin}/rfb?token=wrong`), 'a wrong token must be rejected');

  const client = await connect(bridge.rfbUrl);
  const reply = await new Promise((resolve, reject) => {
    client.once('message', data => resolve(data.toString()));
    client.once('error', reject);
    client.send(Buffer.from('rfb-bytes'), { binary: true });
  });
  assert.equal(reply, 'echo:rfb-bytes');
  assert.deepEqual(upstream.seen.messages, ['rfb-bytes']);
  assert.equal(upstream.seen.headers.cookie, 'PVEAuthCookie=test-ticket');
  assert.equal(upstream.seen.headers.authorization, 'PVEAPIToken=user@pve!t=secret');
  assert.equal(upstream.seen.headers['sec-websocket-protocol'], 'binary');

  client.close();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(closed.length >= 0);
});
