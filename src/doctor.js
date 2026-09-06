import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFingerprint } from './tls-pinning.js';
import { PveApi } from './pve-api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Progressive setup check.
 *
 *   doctor            no credentials are sent: config, build artefacts,
 *                     Chromium, TLS pinning, the unauthenticated API endpoint
 *   doctor --auth     additionally logs in and reads the VM state
 *   doctor --console  additionally opens a real console and captures a frame
 */
export async function runDoctor(config, { auth = false, console: withConsole = false, requestDaemon } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint) => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail ?? ''), ...(ok || !hint ? {} : { hint }) });
    return ok;
  };

  add('config', true, `node=${config.node} vmid=${config.vmid} endpoint=${config.endpoint} (${config.configPath})`);

  const bundle = path.join(root, 'web', 'dist', 'console.bundle.js');
  add('bundle', fs.existsSync(bundle), fs.existsSync(bundle) ? bundle : 'web/dist/console.bundle.js is missing', 'run `npm run build` in the pve-computer-use directory');
  add('chromium', fs.existsSync(config.executablePath), config.executablePath, 'install Chrome/Chromium or set executablePath in the config');

  const api = new PveApi(config);

  let digest = null;
  try {
    const info = await api.peerFingerprint();
    digest = info.fingerprint;
    const pinned = normalizeFingerprint(config.tlsFingerprint || '');
    if (!pinned) {
      add('tls', false, `certificate ${digest} (CN ${info.subject?.CN}) is not pinned`, `set "tlsFingerprint": "${digest}" or provide caFile`);
    } else if (pinned !== digest) {
      add('tls', false, `pinned ${pinned} but the server presents ${digest}`, 're-run `pve-cu fingerprint` only if the certificate was legitimately renewed');
    } else {
      add('tls', true, `pinned ${digest} (CN ${info.subject?.CN}, valid to ${info.validTo})`);
    }
  } catch (error) {
    add('tls', false, error.message, 'check the endpoint, the network route and whether pveproxy is running');
  }

  try {
    const domains = await api.request('GET', '/access/domains');
    add('api', true, `unauthenticated API reachable, realms: ${(domains || []).map(realm => realm.realm).join(', ')}`);
  } catch (error) {
    add('api', false, error.message, 'the API must answer /access/domains without credentials');
  }

  const secretEnv = config.auth?.tokenSecretEnv || config.auth?.passwordEnv || null;
  const secretKind = config.auth?.tokenId ? `API token ${config.auth.tokenId}` : config.auth?.username ? `password login ${config.auth.username}` : null;
  if (!secretEnv) add('credentials', false, 'no auth configured', 'set auth.tokenId+tokenSecretEnv or auth.username+passwordEnv');
  else if (process.env[secretEnv]) add('credentials', true, `${secretKind}; ${secretEnv} is set (${process.env[secretEnv].length} chars, value not shown)`);
  else add('credentials', false, `${secretKind}; ${secretEnv} is NOT set`, `export ${secretEnv}=<secret> in the shell that starts pve-cu`);

  let daemonRunning = false;
  if (typeof requestDaemon === 'function') {
    try {
      const ping = await requestDaemon({ action: 'ping' }, 5_000);
      daemonRunning = ping.ok;
      add('daemon', daemonRunning, `running (uptime ${ping.data?.uptime ?? '?'}s)`);
    } catch (error) {
      // A daemon that is simply not running is normal: any command starts one.
      // A leftover socket that does not answer is a real problem.
      const stale = fs.existsSync(config.socketPath);
      add('daemon', !stale,
        stale ? `socket ${config.socketPath} exists but does not answer: ${error.message}` : 'not running (started on demand by any command)',
        stale ? 'run `pve-cu --target <t> daemon stop`, remove the socket, then retry' : undefined);
    }
  }

  if (auth) {
    if (!process.env[secretEnv]) {
      add('auth', false, 'skipped: the secret environment variable is not set');
    } else {
      try {
        const method = await api.authenticate();
        const status = await api.request('GET', `/nodes/${config.node}/qemu/${config.vmid}/status/current`);
        add('auth', true, `${method.method} login accepted; VMID ${config.vmid} "${status?.name || '?'}" is ${status?.qemu || status?.status || 'unknown'}`);
        if (status?.qemu !== 'running') add('vm-running', false, `VM state is ${status?.qemu || status?.status}`, 'start the VM before opening a console');
        else add('vm-running', true, 'VM is running');
      } catch (error) {
        add('auth', false, error.message, 'check the secret, the user, and that the node name matches `pvenode list` / the web UI');
      }
    }
  }

  if (withConsole) {
    if (typeof requestDaemon !== 'function') add('console', false, 'skipped: no daemon transport available');
    else if (!daemonRunning && !process.env[secretEnv]) add('console', false, 'skipped: credentials are missing');
    else {
      try {
        const frame = await requestDaemon({ action: 'observe' }, 180_000);
        if (!frame.ok) throw new Error(frame.error || 'observe failed');
        add('console', true, `frame ${frame.data.width}x${frame.data.height} saved to ${frame.data.filePath}`);
      } catch (error) {
        add('console', false, error.message, 'run `pve-cu --target <t> daemon log` and inspect the daemon log');
      }
    }
  }

  return { ok: checks.every(check => check.ok), target: config.target, checks };
}
