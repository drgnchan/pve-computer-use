#!/usr/bin/env node
// Boots a mock PVE (REST + vncwebsocket + RFB) and drives the real CLI against it,
// so a captured frame can be inspected visually. The default framebuffer paints four
// known quadrants (red / green / blue / white), which proves the pixel channel order
// end to end: a red-blue swap would be obvious in the resulting image.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PveApi } from '../src/pve-api.js';
import { hasOpenssl, selfSignedCert } from '../test/helpers.mjs';
import { FakePve } from '../test/fake-pve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'pve-cu.js');
const chrome = process.env.PVE_CU_CHROME || '/usr/bin/google-chrome';
if (!hasOpenssl) throw new Error('openssl is required');
if (!fs.existsSync(chrome)) throw new Error(`chromium not found at ${chrome}`);

const run = (args, env) => new Promise(resolve => {
  execFile(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 8e6 },
    (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-mock-'));
const width = Number(process.argv[2] || 320);
const height = Number(process.argv[3] || 200);

const pve = new FakePve({ ...selfSignedCert(dir), node: 'mock', vmid: 999, width, height, pattern: 'quadrants', vmName: 'mock-vm' });
const endpoint = await pve.listen();
const { fingerprint } = await new PveApi({ endpoint, node: 'mock', vmid: 999, tlsOptions: {} }).peerFingerprint();

const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  executablePath: chrome,
  targets: {
    mock: {
      endpoint, node: 'mock', vmid: 999, cacheDir: dir, tlsFingerprint: fingerprint,
      auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_MOCK_TOKEN' },
    },
  },
}, null, 2));
const env = { PVE_CU_CONFIG: configFile, PVE_CU_MOCK_TOKEN: 'tok-secret-value' };

console.log(`mock PVE on ${endpoint} (${width}x${height}, quadrant pattern), config ${configFile}`);

const doctor = await run(['--target', 'mock', 'doctor', '--auth'], env);
console.log('doctor:', doctor.stdout.trim() || doctor.stderr.trim());

const observe = await run(['--target', 'mock', 'observe'], env);
console.log('observe:', observe.stdout.trim() || observe.stderr.trim());

const status = await run(['--target', 'mock', 'status'], env);
console.log('status:', status.stdout.trim() || status.stderr.trim());

await run(['--target', 'mock', 'daemon', 'stop'], env);
await pve.close();

const framePath = (() => { try { return JSON.parse(observe.stdout).filePath; } catch { return null; } })();
console.log(framePath ? `\nFRAME ${framePath}` : '\nno frame produced');
