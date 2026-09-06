// noVNC adapter page: keeps one RFB session and exposes deterministic
// screenshot + input primitives to the daemon through Playwright evaluate().
import * as RFBModule from '@novnc/novnc';
import { SHIFT, MOUSE_MASK } from '../src/keys.js';

// @novnc/novnc >= 1.7 is ESM; tolerate one extra wrapper level from CJS interop.
function resolveRFB(module) {
  for (const candidate of [module?.default?.default, module?.default, module?.RFB, module]) {
    if (typeof candidate === 'function' && typeof candidate.prototype?.sendKey === 'function') return candidate;
  }
  throw new Error('Cannot resolve the noVNC RFB constructor; check the @novnc/novnc version');
}

const RFB = resolveRFB(RFBModule);

const state = {
  connected: false, failure: null, updates: 0, lastUpdateAt: null,
  width: 0, height: 0, mask: 0, held: [], desktopName: null,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rfb() {
  if (!window.__rfb) throw new Error('Console session is not initialised');
  return window.__rfb;
}

function requireInternals() {
  const target = rfb();
  const ok = typeof target.sendKey === 'function'
    && typeof target.toDataURL === 'function'
    && typeof target._handleMouseButton === 'function'
    && typeof target._sendMouse === 'function'
    && typeof target._framebufferUpdate === 'function'
    && target._display && typeof target._display.flush === 'function';
  if (!ok) throw new Error('noVNC internals are missing; this adapter is pinned to @novnc/novnc 1.7.x');
  return target;
}

function assertConnected() {
  const target = requireInternals();
  if (state.failure) throw new Error(`Console connection failed: ${state.failure}`);
  if (!state.connected) throw new Error('Console is not connected yet');
  return target;
}

// Framebuffer pixel -> canvas element pixel (identity while scaling is off).
function toElement(x, y) {
  const display = rfb()._display;
  const scale = display.scale ?? display._scale ?? 1;
  const viewport = display._viewportLoc || { x: 0, y: 0 };
  return { x: Math.round((x - viewport.x) * scale), y: Math.round((y - viewport.y) * scale) };
}

function inBounds(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid coordinate');
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    throw new Error(`Coordinate (${x},${y}) is outside the ${state.width}x${state.height} framebuffer`);
  }
}

function pressKey(target, key) {
  target.sendKey(key.keysym, key.code, true);
  state.held.push(key);
}

function releaseKey(target, key) {
  target.sendKey(key.keysym, key.code, false);
  const index = state.held.findIndex(held => held.keysym === key.keysym && held.code === key.code);
  if (index !== -1) state.held.splice(index, 1);
}

async function tap(target, key, delayMs) {
  const shift = key.shift && SHIFT;
  if (shift) pressKey(target, SHIFT);
  pressKey(target, key);
  await sleep(delayMs);
  releaseKey(target, key);
  if (shift) releaseKey(target, SHIFT);
}

export function startConsole({ url, password }) {
  window.RFB = RFB;
  window.__novncVersionOk = true;
  if (window.__rfb) { try { window.__rfb.disconnect(); } catch {} }
  state.connected = false; state.failure = null; state.mask = 0; state.held = [];
  const target = new RFB(document.getElementById('screen'), url, {
    shared: true, credentials: { password },
  });
  target.scaleViewport = false;   // keep canvas pixels == framebuffer pixels
  target.clipViewport = false;
  target.resizeSession = false;
  target.viewOnly = false;
  target.qualityLevel = 9;
  target.compressionLevel = 2;
  target.addEventListener('connect', () => {
    state.connected = true;
    state.width = target._display.width;
    state.height = target._display.height;
  });
  target.addEventListener('desktopname', event => { state.desktopName = event.detail.name; });
  target.addEventListener('securityfailure', event => {
    state.failure = `security failure ${event.detail.status} ${event.detail.reason || ''}`.trim();
  });
  target.addEventListener('credentialsrequired', () => { state.failure = 'server requested credentials the client cannot provide'; });
  target.addEventListener('disconnect', event => {
    state.connected = false;
    if (!event.detail.clean && !state.failure) state.failure = 'console disconnected unexpectedly';
  });
  // Version-pinned adapter: noVNC 1.6 has no public framebuffer-update event.
  const update = target._framebufferUpdate.bind(target);
  target._framebufferUpdate = () => {
    const complete = update();
    if (complete) {
      state.updates++;
      state.lastUpdateAt = new Date().toISOString();
      state.width = target._display.width;
      state.height = target._display.height;
    }
    return complete;
  };
  window.__rfb = target;
  return { started: true };
}

export async function waitConnected(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.failure) throw new Error(`Console connection failed: ${state.failure}`);
    if (state.connected && state.updates > 0) return report();
    await sleep(150);
  }
  throw new Error('Timed out waiting for the console framebuffer');
}

function report() {
  return {
    connected: state.connected, failure: state.failure, framebufferUpdates: state.updates,
    lastUpdateAt: state.lastUpdateAt, width: state.width, height: state.height,
    desktopName: state.desktopName, heldKeys: state.held.length, mouseMask: state.mask,
  };
}

export function consoleState() { return report(); }

export async function captureFrame({ format = 'png', jpegQuality = 0.9 } = {}) {
  const target = assertConnected();
  if (!state.updates) throw new Error('No framebuffer update received yet');
  await target._display.flush();
  if (!state.connected) throw new Error('Console disconnected while capturing');
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dataUrl = target.toDataURL(mime, format === 'jpeg' ? jpegQuality : undefined);
  const marker = `data:${mime};base64,`;
  if (!dataUrl.startsWith(marker)) throw new Error('Unexpected framebuffer encoding');
  return { ...report(), format, image: dataUrl.slice(marker.length) };
}

export async function mouse({ type, x, y, toX, toY, button = 'left', dy = 0, steps = 12, delayMs = 12 }) {
  const target = assertConnected();
  const bit = MOUSE_MASK[button] ?? MOUSE_MASK.left;
  if (type === 'move') {
    inBounds(x, y);
    const position = toElement(x, y);
    target._sendMouse(position.x, position.y, state.mask);
    return { executed: 'move', ...position };
  }
  if (type === 'click') {
    inBounds(x, y);
    const position = toElement(x, y);
    target._handleMouseButton(position.x, position.y, state.mask | bit);
    state.mask |= bit;
    await sleep(delayMs + 20);
    target._handleMouseButton(position.x, position.y, state.mask & ~bit);
    state.mask &= ~bit;
    await sleep(delayMs + 20);
    return { executed: 'click', button, clicks: 1, ...position };
  }
  if (type === 'double') {
    inBounds(x, y);
    const position = toElement(x, y);
    for (let i = 0; i < 2; i++) {
      target._handleMouseButton(position.x, position.y, state.mask | bit);
      state.mask |= bit;
      await sleep(15);
      target._handleMouseButton(position.x, position.y, state.mask & ~bit);
      state.mask &= ~bit;
      await sleep(60);
    }
    return { executed: 'double', button, ...position };
  }
  if (type === 'drag') {
    inBounds(x, y); inBounds(toX, toY);
    const from = toElement(x, y);
    const to = toElement(toX, toY);
    target._handleMouseButton(from.x, from.y, state.mask | bit);
    state.mask |= bit;
    await sleep(delayMs + 30);
    for (let i = 1; i <= steps; i++) {
      const stepX = Math.round(from.x + (to.x - from.x) * (i / steps));
      const stepY = Math.round(from.y + (to.y - from.y) * (i / steps));
      target._sendMouse(stepX, stepY, state.mask);
      await sleep(delayMs);
    }
    target._handleMouseButton(to.x, to.y, state.mask & ~bit);
    state.mask &= ~bit;
    return { executed: 'drag', button, from, to };
  }
  if (type === 'scroll') {
    inBounds(x, y);
    const position = toElement(x, y);
    const ticks = Math.max(1, Math.min(64, Math.abs(Math.trunc(dy))));
    const wheel = dy < 0 ? MOUSE_MASK.wheelUp : MOUSE_MASK.wheelDown;
    target._sendMouse(position.x, position.y, state.mask);
    for (let i = 0; i < ticks; i++) {
      target._handleMouseButton(position.x, position.y, state.mask | wheel);
      target._handleMouseButton(position.x, position.y, state.mask);
      await sleep(delayMs + 18);
    }
    return { executed: 'scroll', dy, ticks, ...position };
  }
  throw new Error(`Unknown mouse action: ${type}`);
}

export async function typeChars({ chars, delayMs = 22 }) {
  const target = assertConnected();
  for (const key of chars) await tap(target, key, delayMs);
  return { executed: 'type', length: chars.length };
}

export async function keyCombo({ keys, holdMs = 45, delayMs = 20 }) {
  const target = assertConnected();
  for (const key of keys) { pressKey(target, key); await sleep(delayMs); }
  await sleep(holdMs);
  for (const key of keys.slice().reverse()) { releaseKey(target, key); await sleep(delayMs); }
  return { executed: 'key', keys: keys.map(key => key.code) };
}

export async function releaseAll({ delayMs = 15 } = {}) {
  const target = requireInternals();
  const released = state.held.length;
  for (const key of state.held.slice().reverse()) {
    try { target.sendKey(key.keysym, key.code, false); } catch {}
    await sleep(delayMs);
  }
  state.held = [];
  if (state.mask) {
    try { target._sendMouse(0, 0, 0); } catch {}
    state.mask = 0;
  }
  return { executed: 'reset', releasedKeys: released };
}

export function disconnectConsole() {
  try { window.__rfb?.disconnect(); } catch {}
  return { disconnected: true };
}

window.pveConsole = {
  startConsole, waitConnected, consoleState, captureFrame, mouse,
  typeChars, keyCombo, releaseAll, disconnectConsole,
};
