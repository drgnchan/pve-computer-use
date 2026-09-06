#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, listTargets, loadConfig } from './config.js';
import { PveApi } from './pve-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIMEOUTS = { status: 120_000, observe: 120_000, screenshot: 120_000, reconnect: 120_000, default: 45_000 };
const ALIASES = { screenshot: 'observe', doubleclick: 'double-click', keypress: 'key' };

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('-')) {
      const key = arg.replace(/^-+/, '');
      const name = key === 't' ? 'target' : key;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { options[name] = next; i++; }
      else options[name] = true;
    } else positional.push(arg);
  }
  return { command: positional.shift() || 'status', positional, options };
}

function send(socketPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = net.createConnection(socketPath);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Daemon request "${request.action}" timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, newline))); } catch { finish(new Error('Daemon returned invalid JSON')); }
    });
    socket.once('error', () => finish(new Error('Daemon socket is unavailable')));
    socket.once('end', () => finish(new Error('Daemon closed the connection without a response')));
  });
}

async function ensureDaemon(config) {
  try {
    const ping = await send(config.socketPath, { action: 'ping' }, 5_000);
    if (ping.ok) return false;
  } catch {
    try { fs.unlinkSync(config.socketPath); } catch {}
  }
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const logStream = fs.openSync(path.join(config.runtimeDir, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js'), config.target], {
    detached: true, stdio: ['ignore', logStream, logStream], env: { ...process.env, PVE_CU_CONFIG: config.configPath },
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(config.socketPath)) {
      try {
        const ping = await send(config.socketPath, { action: 'ping' }, 5_000);
        if (ping.ok) return true;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Daemon did not start; see ${path.join(config.runtimeDir, 'daemon.log')}`);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function printHelp() {
  console.log(`pve-cu - control a Proxmox VE virtual machine console (noVNC/RFB)

Usage:
  pve-cu --target <name> <command> [options]

Targets are defined in ${configPath()}

Commands:
  status                                   console/session health + framebuffer size
  observe | screenshot                     save a frame, print its filePath
  click --x <x> --y <y> [--button left|right|middle] [--space 1000]
  double-click --x <x> --y <y> [--button ...]
  move --x <x> --y <y>
  drag --from-x <x1> --from-y <y1> --to-x <x2> --to-y <y2> [--button left]
  scroll --x <x> --y <y> --dy <n>          n > 0 scrolls down, n < 0 up
  type --text "<ascii text>"
  key --keys "ctrl,l"                      combo or single key (Enter, Escape, f5, ...)
  reset                                    release every held key and mouse button
  reconnect                                drop and reopen the console session
  fingerprint                              print the PVE TLS certificate SHA-256 to pin
  tlscheck                                 verify endpoint + certificate pinning (no credentials sent)
  daemon start|stop|log
  targets                                  list configured targets
  help

Coordinates: 0.0..1.0 normalised, or pixels of the current framebuffer,
or any space with --space (e.g. --x 500 --y 500 --space 1000).

The target VM must be running, and the configured user needs VM.Console.
Environment variables hold secrets (see config example); never pass them as CLI arguments.`);
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || options.help || options.h) return printHelp();

  if (command === 'targets') {
    try {
      console.log(JSON.stringify({ configPath: configPath(), targets: listTargets() }, null, 2));
    } catch (error) { fail(error.message); }
    return;
  }

  const target = options.target || process.env.PVE_CU_TARGET;
  if (!target) fail('Missing --target <name> (or PVE_CU_TARGET); run `pve-cu targets`');
  let config;
  try { config = loadConfig(target); } catch (error) { return fail(error.message); }

  if (command === 'tlscheck') {
    // Setup helper: proves reachability + certificate pinning using an endpoint
    // that PVE serves without authentication. Never sends credentials.
    try {
      const api = new PveApi(config);
      const started = Date.now();
      const domains = await api.request('GET', '/access/domains');
      console.log(JSON.stringify({
        ok: true, target, endpoint: config.endpoint, tlsMode: config.tlsMode,
        realms: (domains || []).map(realm => realm.realm).sort(), roundTripMs: Date.now() - started,
      }, null, 2));
    } catch (error) { fail(error.message); }
    return;
  }

  if (command === 'fingerprint') {
    try {
      const info = await new PveApi(config).peerFingerprint();
      console.log(JSON.stringify({ ok: true, target, ...info, hint: 'add "tlsFingerprint": "<fingerprint>" to this target in the config' }, null, 2));
    } catch (error) { fail(error.message); }
    return;
  }

  if (command === 'daemon') {
    const sub = positional[0] || options.subcommand || 'start';
    if (sub === 'start') return await new (await import('./daemon.js')).PveDaemon(target).start();
    if (sub === 'stop') {
      if (!fs.existsSync(config.socketPath)) return console.log(JSON.stringify({ ok: true, message: 'Daemon not running' }));
      try { await send(config.socketPath, { action: 'shutdown' }, 30_000); } catch (error) { return fail(error.message); }
      return console.log(JSON.stringify({ ok: true, message: 'Daemon stopped' }));
    }
    if (sub === 'log') return console.log(path.join(config.runtimeDir, 'daemon.log'));
    return fail(`Unknown daemon subcommand: ${sub}`);
  }

  const action = ALIASES[command] || command;
  try {
    await ensureDaemon(config);
    const response = await send(config.socketPath, { action, params: options }, TIMEOUTS[action] || TIMEOUTS.default);
    if (!response.ok) return fail(response.error || 'Daemon rejected the request');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    fail(error.message);
  }
}

main().catch(error => fail(process.env.PVE_CU_DEBUG ? error?.stack || String(error) : error?.message || String(error)));
