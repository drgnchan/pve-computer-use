import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PveDaemon } from '../src/daemon.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

class MockSession {
  constructor(config) {
    this.config = config;
    this.framebuffer = { width: 1920, height: 1080 };
    this.calls = [];
    this.updates = 5;
    this.closed = false;
    this.aliveChecks = 0;
  }
  async start() { return await this.state(); }
  async ensureAlive() { this.aliveChecks++; }
  async state() { return { connected: true, width: 1920, height: 1080, framebufferUpdates: this.updates, lastUpdateAt: '2026-01-01T00:00:00.000Z' }; }
  async evaluate(fn, arg) {
    this.calls.push({ fn, arg });
    if (fn === 'consoleState') return { connected: true, width: 1920, height: 1080, framebufferUpdates: this.updates };
    if (fn === 'waitForChange') return { changed: true, waitedMs: 12, baselineUpdates: arg.baseline, framebufferUpdates: this.updates + 1 };
    return { executed: fn, arg, framebufferUpdates: this.updates };
  }
  async capture() {
    return { format: 'png', width: 1920, height: 1080, image: PNG_1PX, framebufferUpdates: this.updates, lastUpdateAt: '2026-01-01T00:00:00.000Z' };
  }
  async close() { this.closed = true; }
}

function send(socketPath, request) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

async function startDaemon(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-daemon-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    targets: { lab: { endpoint: 'https://192.0.2.10:8006', node: 'pve-node', vmid: 105, cacheDir: dir, auth: { tokenId: 'u@pve!t', tokenSecretEnv: 'PVE_CU_TEST_TOKEN' }, ...extra } },
  }));
  process.env.PVE_CU_CONFIG = file;
  process.env.PVE_CU_TEST_TOKEN = 'secret';
  const sessions = [];
  const daemon = new PveDaemon('lab', { sessionFactory: config => { const session = new MockSession(config); sessions.push(session); return session; } });
  await daemon.start();
  t.after(async () => {
    try { daemon.server.close(); } catch {}
    try { fs.unlinkSync(daemon.config.socketPath); } catch {}
    delete process.env.PVE_CU_CONFIG;
  });
  return { daemon, sessions, socketPath: daemon.config.socketPath, dir };
}

test('daemon exposes status, screenshots and serialized input actions', async t => {
  const { daemon, sessions, socketPath } = await startDaemon(t);

  assert.equal((await send(socketPath, { action: 'ping' })).data.target, 'lab');

  const status = await send(socketPath, { action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.data.width, 1920);
  assert.equal(status.data.connected, true);
  assert.equal(sessions.length, 1, 'one session must be reused');

  const frame = await send(socketPath, { action: 'observe' });
  assert.equal(frame.ok, true);
  assert.equal(frame.data.width, 1920);
  assert.ok(fs.existsSync(frame.data.filePath));
  assert.equal(fs.readFileSync(frame.data.filePath).length, Buffer.from(PNG_1PX, 'base64').length);
  assert.equal(fs.statSync(frame.data.filePath).mode & 0o777, 0o600);

  const click = await send(socketPath, { action: 'click', params: { x: 0.5, y: 0.5 } });
  assert.equal(click.ok, true);
  assert.deepEqual(sessions[0].calls.at(-1), { fn: 'mouse', arg: { type: 'click', x: 960, y: 540, button: 'left' } });
  assert.ok(Math.abs(click.data.normX - 0.5) < 0.001);
  assert.ok(Math.abs(click.data.normY - 0.5) < 0.001);

  await send(socketPath, { action: 'click', params: { x: 500, y: 500, space: 1000 } });
  assert.deepEqual(sessions[0].calls.at(-1).arg, { type: 'click', x: 960, y: 540, button: 'left' });

  await send(socketPath, { action: 'click', params: { x: 100, y: 200, button: 'right' } });
  assert.deepEqual(sessions[0].calls.at(-1).arg, { type: 'click', x: 100, y: 200, button: 'right' });

  const drag = await send(socketPath, { action: 'drag', params: { 'from-x': 0.1, 'from-y': 0.1, 'to-x': 100, 'to-y': 100 } });
  assert.equal(drag.ok, true);
  assert.deepEqual(sessions[0].calls.at(-1).arg, { type: 'drag', x: 192, y: 108, toX: 100, toY: 100, button: 'left' });

  await send(socketPath, { action: 'scroll', params: { x: 0.5, y: 0.5, dy: -3 } });
  assert.deepEqual(sessions[0].calls.at(-1).arg, { type: 'scroll', x: 960, y: 540, dy: -3 });

  const typed = await send(socketPath, { action: 'type', params: { text: 'aB1!' } });
  assert.equal(typed.ok, true);
  assert.equal(sessions[0].calls.at(-1).arg.chars.length, 4);
  assert.equal(sessions[0].calls.at(-1).arg.chars[3].code, 'Digit1');

  const combo = await send(socketPath, { action: 'key', params: { keys: 'ctrl,l' } });
  assert.equal(combo.ok, true);
  assert.deepEqual(sessions[0].calls.at(-1).arg.keys.map(key => key.code), ['ControlLeft', 'KeyL']);

  const reset = await send(socketPath, { action: 'reset' });
  assert.equal(reset.ok, true);
  assert.equal(sessions[0].calls.at(-1).fn, 'releaseAll');

  const reconnect = await send(socketPath, { action: 'reconnect' });
  assert.equal(reconnect.ok, true);
  assert.equal(sessions.length, 2, 'reconnect must build a fresh session');
  assert.equal(sessions[0].closed, true);
});

test('daemon rejects bad input without touching the console', async t => {
  const { sessions, socketPath } = await startDaemon(t);

  assert.equal((await send(socketPath, { action: 'unknown' })).ok, false);
  assert.match((await send(socketPath, { action: 'click', params: { x: 0.5 } })).error, /Invalid coordinate/);
  assert.match((await send(socketPath, { action: 'click', params: { x: 5000, y: 5 } })).error, /outside the 1920px framebuffer/);
  assert.match((await send(socketPath, { action: 'type', params: { text: '你好' } })).error, /ASCII only/);
  assert.match((await send(socketPath, { action: 'scroll', params: { x: 0.5, y: 0.5, dy: 0 } })).error, /non-zero/);
  assert.match((await send(socketPath, { action: 'key', params: { keys: 'nope' } })).error, /Unknown key name/);
  for (const session of sessions) assert.equal(session.calls.length, 0);
});

test('an idle console session is released and reopened on demand', async t => {
  const { sessions, socketPath } = await startDaemon(t, { idleTimeoutMs: 40, idleCheckIntervalMs: 15 });

  const first = await send(socketPath, { action: 'status' });
  assert.equal(first.ok, true);
  assert.equal(sessions.length, 1);
  assert.equal(first.data.idleReleases, 0);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(sessions[0].closed, true, 'the idle session must be closed');

  const second = await send(socketPath, { action: 'status' });
  assert.equal(second.ok, true);
  assert.equal(sessions.length, 2, 'the next command must reopen a session');
  assert.equal(second.data.idleReleases, 1);
  assert.equal(second.data.idleTimeoutMs, 40);
  assert.ok(second.data.idleForMs < 1000);
});

test('a ping does not keep an idle session alive', async t => {
  const { sessions, socketPath } = await startDaemon(t, { idleTimeoutMs: 40, idleCheckIntervalMs: 15 });

  await send(socketPath, { action: 'status' });
  for (let i = 0; i < 8; i++) {
    await send(socketPath, { action: 'ping' });
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(sessions[0].closed, true, 'pings must not pin the console session');
});

test('observe --wait-change waits against the frame counter of the last input action', async t => {
  const { sessions, socketPath } = await startDaemon(t);

  const plain = await send(socketPath, { action: 'observe' });
  assert.equal(plain.ok, true);
  assert.equal(sessions[0].calls.some(call => call.fn === 'waitForChange'), false, 'no waiting unless asked');
  assert.equal(plain.data.changed, undefined);

  await send(socketPath, { action: 'click', params: { x: 0.5, y: 0.5 } });
  const frame = await send(socketPath, { action: 'observe', params: { 'wait-change': true, 'wait-timeout': 1500 } });
  assert.equal(frame.ok, true);
  const wait = sessions[0].calls.find(call => call.fn === 'waitForChange');
  assert.deepEqual(wait.arg, { baseline: 5, timeoutMs: 1500 }, 'the baseline must come from the click, not from now');
  assert.equal(frame.data.changed, true);
  assert.equal(frame.data.waitedMs, 12);
  assert.equal(frame.data.framebufferUpdates, 5, 'the captured frame count is authoritative');

  await send(socketPath, { action: 'observe', params: { 'wait-change': true } });
  assert.deepEqual(sessions[0].calls.filter(call => call.fn === 'waitForChange').at(-1).arg, { baseline: 6, timeoutMs: 5000 });
});

test('a released or replaced session does not leak the old --wait-change baseline', async t => {
  const { sessions, socketPath } = await startDaemon(t, { idleTimeoutMs: 40, idleCheckIntervalMs: 15 });

  // Baseline 5 is recorded against the first session...
  await send(socketPath, { action: 'click', params: { x: 0.5, y: 0.5 } });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(sessions[0].closed, true, 'the idle session must be released');

  // ...and the replacement session starts counting from zero again.
  await send(socketPath, { action: 'status' });
  assert.equal(sessions.length, 2);
  sessions[1].updates = 2;
  await send(socketPath, { action: 'observe', params: { 'wait-change': true, 'wait-timeout': 500 } });
  assert.deepEqual(sessions[1].calls.find(call => call.fn === 'waitForChange').arg,
    { baseline: 2, timeoutMs: 500 }, 'a fresh session must not wait for the previous frame counter');

  // reconnect replaces the session the same way.
  await send(socketPath, { action: 'reconnect' });
  sessions[2].updates = 3;
  await send(socketPath, { action: 'observe', params: { 'wait-change': true } });
  assert.deepEqual(sessions[2].calls.find(call => call.fn === 'waitForChange').arg,
    { baseline: 3, timeoutMs: 5000 });
});

test('input plus stable observation returns a frame without repeating input', async t => {
  const { sessions, socketPath } = await startDaemon(t);
  const r = await send(socketPath, { action: 'click', params: {
    x: 0.5, y: 0.5, observe: true, 'wait-stable': true, 'min-wait': 2000,
  } });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.data.frame.filePath));
  assert.ok(r.data.timings.totalMs >= 0);
  assert.equal(sessions[0].calls.filter(c => c.fn === 'mouse').length, 1);
  assert.deepEqual(sessions[0].calls.find(c => c.fn === 'waitForStable').arg,
    { baseline: 5, timeoutMs: 5000, stableMs: 800, minWaitMs: 2000 });
});

test('observation failure preserves successful input and invalid waits send no input', async t => {
  const { sessions, socketPath } = await startDaemon(t);
  const bad = await send(socketPath, { action: 'click', params: {
    x: 0.5, y: 0.5, observe: true, 'wait-timeout': 'oops',
  } });
  assert.equal(bad.ok, false);
  assert.equal(sessions.length, 0);
  await send(socketPath, { action: 'status' });
  sessions[0].capture = async () => { throw new Error('capture failed'); };
  const r = await send(socketPath, { action: 'key', params: { keys: 'Enter', observe: true } });
  assert.equal(r.ok, true);
  assert.equal(r.data.executed, 'keyCombo');
  assert.equal(r.data.observationError, 'capture failed');
  assert.equal(sessions[0].calls.filter(c => c.fn === 'keyCombo').length, 1);
});

test('frames are pruned to the configured count', async t => {
  const { socketPath, dir } = await startDaemon(t, { frameKeep: 3 });
  const paths = [];
  for (let i = 0; i < 5; i++) paths.push((await send(socketPath, { action: 'observe' })).data.filePath);
  await new Promise(resolve => setTimeout(resolve, 50));
  const remaining = fs.readdirSync(path.join(dir, 'lab', 'frames'));
  assert.equal(remaining.length, 3);
  assert.ok(remaining.includes(path.basename(paths.at(-1))));
});
