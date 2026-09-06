import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { ConsoleBridge } from '../src/bridge.js';
import { PveApi } from '../src/pve-api.js';
import { createPinnedAgent, normalizeFingerprint } from '../src/tls-pinning.js';
import { hasOpenssl, selfSignedCert } from './helpers.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const skip = hasOpenssl ? false : 'openssl not installed';

async function fakePve(tlsMaterial) {
  const served = { requests: 0 };
  const server = https.createServer(tlsMaterial, (_req, res) => {
    served.requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { version: '9.0.0', release: 'fake' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, served, endpoint: `https://127.0.0.1:${server.address().port}` };
}

const apiConfig = (endpoint, tlsOptions) => ({ endpoint, node: 'lab', vmid: 105, tlsOptions, insecureTls: false });

test('fingerprint pinning accepts the pinned leaf and never talks to an impostor', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-tls-'));
  const pve = await fakePve(selfSignedCert(dir));
  t.after(() => pve.server.close());

  const info = await new PveApi(apiConfig(pve.endpoint, {})).peerFingerprint();
  assert.match(info.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(info.subject.CN, '127.0.0.1');
  assert.equal(info.selfSigned, true);
  assert.match(info.sans, /IP Address:127\.0\.0\.1/);

  const pinnedAgent = createPinnedAgent({ fingerprint: info.fingerprint, host: '127.0.0.1' });
  const ok = new PveApi(apiConfig(pve.endpoint, { agent: pinnedAgent }));
  assert.deepEqual(await ok.request('GET', '/version'), { version: '9.0.0', release: 'fake' });
  assert.equal(pve.served.requests, 1);

  // Regression: a reused TLS session would hide the certificate and break pinning.
  for (let round = 2; round <= 4; round++) {
    assert.deepEqual(await ok.request('GET', '/version'), { version: '9.0.0', release: 'fake' }, `request ${round} must stay pinned`);
    assert.equal(pve.served.requests, round);
  }

  // `openssl x509 -fingerprint` style (upper case, colon separated) must work too.
  const colonForm = info.fingerprint.replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
  assert.equal(normalizeFingerprint(colonForm), info.fingerprint);
  const okColon = new PveApi(apiConfig(pve.endpoint, { agent: createPinnedAgent({ fingerprint: colonForm, host: '127.0.0.1' }) }));
  assert.deepEqual(await okColon.request('GET', '/version'), { version: '9.0.0', release: 'fake' });

  const wrong = new PveApi(apiConfig(pve.endpoint, { agent: createPinnedAgent({ fingerprint: '0'.repeat(64), host: '127.0.0.1' }) }));
  await assert.rejects(() => wrong.request('GET', '/version'), /fingerprint mismatch/);
  assert.equal(pve.served.requests, 5, 'a rejected certificate must not receive the request (no credential leak)');

  const wrongHost = new PveApi(apiConfig(pve.endpoint, { agent: createPinnedAgent({ fingerprint: info.fingerprint, host: 'pve.example.invalid' }) }));
  await assert.rejects(() => wrongHost.request('GET', '/version'), /does not match pve\.example\.invalid/);
  assert.equal(pve.served.requests, 5);

  // Without a pin the private CA must not be trusted silently.
  await assert.rejects(() => new PveApi(apiConfig(pve.endpoint, {})).request('GET', '/version'), /UNABLE_TO_VERIFY_LEAF_SIGNATURE|self-signed/);
  assert.equal(pve.served.requests, 5);
});

test('the console bridge refuses a wss upstream whose certificate is not pinned', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-tls-'));
  const served = { connections: 0 };
  const server = https.createServer(selfSignedCert(dir));
  const wss = new WebSocketServer({ server, path: '/console' });
  wss.on('connection', socket => { served.connections++; socket.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { wss.close(); server.close(); });
  const upstreamUrl = `wss://127.0.0.1:${server.address().port}/console?port=5900&vncticket=secret-ticket`;

  const closed = [];
  const bridge = await new ConsoleBridge({
    upstreamUrl,
    // Deliberately wrong pin: the ticket in the URL must never reach this server.
    headers: { Cookie: 'PVEAuthCookie=secret-cookie' },
    tlsOptions: { agent: createPinnedAgent({ fingerprint: 'ab'.repeat(32), host: '127.0.0.1' }) },
    webRoot,
    onUpstreamClosed: reason => closed.push(reason),
  }).start();
  t.after(() => bridge.close());

  const client = new WebSocket(bridge.rfbUrl, ['binary']);
  const outcome = await new Promise(resolve => {
    client.once('close', () => resolve('closed'));
    client.once('error', error => resolve(`error:${error.message}`));
    setTimeout(() => resolve('timeout'), 8_000);
  });
  assert.notEqual(outcome, 'timeout', 'the bridge must drop an unpinned upstream');
  assert.ok(closed.some(reason => /fingerprint mismatch/.test(reason)), `expected a pin failure, got: ${JSON.stringify(closed)} / ${outcome}`);
  assert.equal(served.connections, 0, 'the impostor must never see the vncticket or the auth cookie');
});

test('a caFile pin validates the whole chain', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-tls-'));
  const material = selfSignedCert(dir);
  const pve = await fakePve(material);
  t.after(() => pve.server.close());

  const api = new PveApi(apiConfig(pve.endpoint, { ca: material.cert }));
  assert.deepEqual(await api.request('GET', '/version'), { version: '9.0.0', release: 'fake' });
  assert.equal(pve.served.requests, 1);
});
