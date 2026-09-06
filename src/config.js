import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPinnedAgent, isFingerprint } from './tls-pinning.js';

export function configPath() {
  return process.env.PVE_CU_CONFIG || path.join(os.homedir(), '.config/pve-cu/config.json');
}

function readRootConfig(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Config not found at ${file}; copy config.example.json there and define at least one target`);
  }
  try {
    const root = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!root.targets || typeof root.targets !== 'object') throw new Error('missing "targets" object');
    return root;
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export function listTargets() {
  return Object.keys(readRootConfig(configPath()).targets);
}

export function loadConfig(target, file = configPath()) {
  if (!/^[a-zA-Z0-9_-]+$/.test(target || '')) throw new Error('A valid --target is required');
  const root = readRootConfig(file);
  const entry = root.targets[target];
  if (!entry) throw new Error(`Unknown target "${target}"; configured targets: ${Object.keys(root.targets || {}).join(', ') || '(none)'}`);

  const endpoint = new URL(entry.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('endpoint must be an HTTPS origin such as https://192.0.2.10:8006');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(entry.node || '')) throw new Error('target.node must be a PVE node name');
  if (!Number.isSafeInteger(entry.vmid) || entry.vmid < 100) throw new Error('target.vmid must be a numeric VMID >= 100');

  if (entry.tlsFingerprint && !isFingerprint(entry.tlsFingerprint)) throw new Error('tlsFingerprint must be a SHA-256 hex digest (64 hex characters)');

  const runtimeDir = path.join(entry.cacheDir || path.join(os.homedir(), '.cache/pve-cu'), target);
  const framesDir = path.join(runtimeDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);

  const tlsOptions = {};
  if (entry.caFile) tlsOptions.ca = fs.readFileSync(entry.caFile);
  else if (entry.tlsFingerprint) {
    // PVE ships a private cluster CA and does not send it during the handshake,
    // so pin the leaf digest (verified before any request byte is written).
    tlsOptions.agent = createPinnedAgent({ fingerprint: entry.tlsFingerprint, host: endpoint.hostname });
  } else if (entry.insecureTls === true) tlsOptions.rejectUnauthorized = false;

  return {
    target, configPath: file, endpoint: endpoint.origin, node: entry.node, vmid: entry.vmid,
    auth: entry.auth || {}, runtimeDir, framesDir, socketPath: entry.socketPath || path.join(runtimeDir, 'daemon.sock'),
    tlsOptions, tlsMode: entry.caFile ? 'ca-file' : entry.tlsFingerprint ? 'pinned-fingerprint' : entry.insecureTls ? 'insecure' : 'system-trust',
    insecureTls: entry.insecureTls === true && !entry.caFile && !entry.tlsFingerprint,
    imageFormat: entry.imageFormat === 'jpeg' ? 'jpeg' : 'png', jpegQuality: entry.jpegQuality ?? 0.9, frameKeep: entry.frameKeep ?? 20,
    // Release the console ticket and the headless browser when idle; the next
    // command transparently reopens a session. 0 keeps the session forever.
    idleTimeoutMs: entry.idleTimeoutMs ?? 600_000,
    idleCheckIntervalMs: entry.idleCheckIntervalMs ?? 0,
    executablePath: entry.executablePath || root.executablePath || process.env.PVE_CU_CHROME || '/usr/bin/google-chrome',
    connectTimeoutMs: entry.connectTimeoutMs ?? 25000, maxViewport: entry.maxViewport ?? 3840,
  };
}


/** Coordinate accepted as 0..1 (normalised), or pixels when a framebuffer size is known. */
export function coordinate(value, dimension) {
  const parsed = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(parsed)) throw new Error(`Invalid coordinate: ${value}`);
  if (parsed < 0) throw new Error(`Invalid coordinate: ${value}`);
  if (parsed <= 1) {
    if (!dimension) throw new Error('Normalised coordinates need a known framebuffer size; run observe first');
    return Math.min(dimension - 1, Math.round(parsed * (dimension - 1)));
  }
  const pixel = Math.round(parsed);
  if (dimension && pixel >= dimension) throw new Error(`Coordinate ${pixel} is outside the ${dimension}px framebuffer`);
  return pixel;
}
