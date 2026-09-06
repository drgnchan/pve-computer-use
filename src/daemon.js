import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { coordinate, loadConfig } from './config.js';
import { comboPlan, textPlan } from './keys.js';
import { ConsoleSession } from './session.js';

const log = (...args) => console.error('[pve-cu daemon]', ...args);

export class PveDaemon {
  constructor(target, { sessionFactory = config => new ConsoleSession(config) } = {}) {
    this.config = loadConfig(target);
    this.sessionFactory = sessionFactory;
    this.session = null;
    this.sessionPromise = null;
    this.queue = Promise.resolve();
    this.latestFrame = null;
    this.server = null;
    this.shuttingDown = false;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.idleTimer = null;
    this.idleReleases = 0;
  }

  async start() {
    log(`target ${this.config.target} -> ${this.config.endpoint} node=${this.config.node} vmid=${this.config.vmid}`);
    if (this.config.insecureTls) log('WARNING: TLS verification disabled (insecureTls); credentials travel over an unverified channel');
    if (fs.existsSync(this.config.socketPath)) { try { fs.unlinkSync(this.config.socketPath); } catch {} }

    this.server = net.createServer(socket => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.socketPath, () => { this.server.removeListener('error', reject); resolve(); });
    });
    fs.chmodSync(this.config.socketPath, 0o600);
    log(`listening on ${this.config.socketPath}`);
    if (this.config.idleTimeoutMs > 0) log(`idle release after ${Math.round(this.config.idleTimeoutMs / 1000)}s of inactivity`);
    this.armIdleTimer();

    const stop = () => this.shutdown();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }

  handleSocket(socket) {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_000_000) { socket.destroy(); return; }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { this.reply(socket, { ok: false, error: 'Invalid JSON request' }); continue; }
        const response = await this.enqueue(() => this.dispatch(request)).catch(error => ({ ok: false, error: error?.message || String(error) }));
        this.reply(socket, response);
      }
    });
  }

  reply(socket, response) {
    try { socket.write(`${JSON.stringify(response)}\n`); } catch {}
  }

  /** Input actions must never interleave; screenshot/status may queue behind them. */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensureSession() {
    if (this.session) { await this.session.ensureAlive(); return this.session; }
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        const session = this.sessionFactory(this.config);
        log('opening console session...');
        await session.start();
        this.session = session;
        log(`console connected: ${session.framebuffer.width}x${session.framebuffer.height} updates=${(await session.state()).framebufferUpdates}`);
        return session;
      })().catch(error => { this.sessionPromise = null; throw error; });
    }
    return await this.sessionPromise;
  }

  /** Periodically drops an unused console session so the ticket and browser are not held forever. */
  armIdleTimer() {
    const timeout = this.config.idleTimeoutMs;
    if (!(timeout > 0)) return;
    const interval = this.config.idleCheckIntervalMs > 0
      ? this.config.idleCheckIntervalMs
      : Math.max(5_000, Math.min(60_000, Math.round(timeout / 10)));
    this.idleTimer = setInterval(() => { this.enqueue(() => this.idleCheck()).catch(() => {}); }, interval);
    this.idleTimer.unref?.();
  }

  async idleCheck() {
    if (!this.session || this.shuttingDown) return;
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.config.idleTimeoutMs) return;
    const session = this.session;
    this.session = null;
    this.sessionPromise = null;
    this.idleReleases++;
    log(`idle for ${Math.round(idleFor / 1000)}s: releasing the console session (ticket + browser); the next command reopens it`);
    try { await session.close(); } catch {}
  }

  async dispatch(request) {
    const action = request?.action;
    const params = request?.params || {};
    // A ping only proves the daemon is alive; it must not keep a session pinned.
    if (action !== 'ping') this.lastActivityAt = Date.now();
    switch (action) {
      case 'ping':
        return { ok: true, data: { status: 'pong', target: this.config.target, uptime: Math.round(process.uptime()) } };

      case 'status': {
        const session = await this.ensureSession();
        return {
          ok: true,
          data: {
            ...await session.state(), startedAt: new Date(this.startedAt).toISOString(), latestFrame: this.latestFrame,
            idleTimeoutMs: this.config.idleTimeoutMs, idleForMs: Date.now() - this.lastActivityAt, idleReleases: this.idleReleases,
          },
        };
      }

      case 'reconnect': {
        this.session?.close().catch(() => {});
        this.session = null; this.sessionPromise = null;
        const session = await this.ensureSession();
        return { ok: true, data: await session.state() };
      }

      case 'observe':
      case 'screenshot':
        return { ok: true, data: await this.capture() };

      case 'click':
      case 'double_click':
      case 'double-click': {
        const session = await this.ensureSession();
        const { x, y } = this.position(params);
        const button = this.button(params.button);
        const data = await session.evaluate('mouse', { type: action === 'click' ? 'click' : 'double', x, y, button });
        return { ok: true, data: { ...data, normX: normalize(x, this.dims().width), normY: normalize(y, this.dims().height) } };
      }

      case 'move': {
        const session = await this.ensureSession();
        const { x, y } = this.position(params);
        const data = await session.evaluate('mouse', { type: 'move', x, y });
        return { ok: true, data: { ...data, normX: normalize(x, this.dims().width), normY: normalize(y, this.dims().height) } };
      }

      case 'drag': {
        const session = await this.ensureSession();
        const { width, height } = this.dims();
        const fromX = coordinate(pick(params, ['from-x', 'fromX', 'from_x']), width);
        const fromY = coordinate(pick(params, ['from-y', 'fromY', 'from_y']), height);
        const toX = coordinate(pick(params, ['to-x', 'toX', 'to_x']), width);
        const toY = coordinate(pick(params, ['to-y', 'toY', 'to_y']), height);
        const data = await session.evaluate('mouse', { type: 'drag', x: fromX, y: fromY, toX, toY, button: this.button(params.button) });
        return { ok: true, data };
      }

      case 'scroll': {
        const session = await this.ensureSession();
        const { x, y } = this.position(params);
        const dy = Number(params.dy ?? params.deltaY ?? 3);
        if (!Number.isFinite(dy) || dy === 0) throw new Error('scroll needs a non-zero --dy');
        const data = await session.evaluate('mouse', { type: 'scroll', x, y, dy });
        return { ok: true, data };
      }

      case 'type': {
        const session = await this.ensureSession();
        const text = String(params.text ?? '');
        const data = await session.evaluate('typeChars', { chars: textPlan(text) });
        return { ok: true, data: { ...data, typed: text.length } };
      }

      case 'key':
      case 'keypress': {
        const session = await this.ensureSession();
        const keys = comboPlan(params.keys ?? params.key);
        const data = await session.evaluate('keyCombo', { keys });
        return { ok: true, data: { ...data, keys: keys.map(key => key.code).join('+') } };
      }

      case 'reset': {
        if (!this.session) return { ok: true, data: { executed: 'reset', releasedKeys: 0, note: 'no session' } };
        const data = await this.session.evaluate('releaseAll', {});
        return { ok: true, data };
      }

      case 'shutdown':
        setImmediate(() => this.shutdown());
        return { ok: true, data: { executed: 'shutdown', target: this.config.target } };

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  dims() {
    const { width, height } = this.session?.framebuffer || { width: 0, height: 0 };
    if (!width || !height) throw new Error('Framebuffer size is unknown; run `observe` or `status` first');
    return { width, height };
  }

  position(params) {
    const { width, height } = this.dims();
    const space = params.space ? Number(params.space) : 0;
    const x = space ? Math.round((Number(params.x) / space) * (width - 1)) : coordinate(params.x, width);
    const y = space ? Math.round((Number(params.y) / space) * (height - 1)) : coordinate(params.y, height);
    return { x, y };
  }

  button(value) {
    const button = String(value || 'left').toLowerCase();
    if (!['left', 'right', 'middle'].includes(button)) throw new Error(`Unknown mouse button: ${value}`);
    return button;
  }

  async capture() {
    const session = await this.ensureSession();
    const frame = await session.capture();
    const extension = frame.format === 'jpeg' ? 'jpg' : 'png';
    const frameId = `frame_${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}_${crypto.randomBytes(3).toString('hex')}`;
    const filePath = path.join(this.config.framesDir, `${frameId}.${extension}`);
    fs.writeFileSync(filePath, Buffer.from(frame.image, 'base64'), { mode: 0o600 });
    this.latestFrame = { frameId, filePath, width: frame.width, height: frame.height, capturedAt: new Date().toISOString() };
    this.pruneFrames();
    return { ...this.latestFrame, framebufferUpdates: frame.framebufferUpdates, lastUpdateAt: frame.lastUpdateAt, target: this.config.target };
  }

  pruneFrames() {
    try {
      const files = fs.readdirSync(this.config.framesDir)
        .map(name => ({ name, mtime: fs.statSync(path.join(this.config.framesDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const file of files.slice(this.config.frameKeep)) fs.unlinkSync(path.join(this.config.framesDir, file.name));
    } catch {}
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log('shutting down');
    if (this.idleTimer) clearInterval(this.idleTimer);
    try { await this.session?.close(); } catch {}
    if (this.server) { try { this.server.close(); } catch {} }
    try { fs.unlinkSync(this.config.socketPath); } catch {}
    process.exit(0);
  }
}

function pick(params, keys) {
  for (const key of keys) if (params[key] !== undefined) return params[key];
  return undefined;
}

function normalize(pixel, dimension) {
  if (!dimension || dimension < 2) return null;
  return Number((pixel / (dimension - 1)).toFixed(4));
}

const target = process.argv[2] || process.env.PVE_CU_TARGET;
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  if (!target) {
    console.error('[pve-cu daemon] usage: daemon.js <target>');
    process.exit(1);
  }
  const daemon = new PveDaemon(target);
  daemon.start().catch(error => { log('fatal:', error?.message || error); process.exit(1); });
}
