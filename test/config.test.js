import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { coordinate, loadConfig } from '../src/config.js';

function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    executablePath: '/usr/bin/google-chrome',
    targets: {
      lab: { endpoint: 'https://192.0.2.10:8006', node: 'pve-node', vmid: 105, cacheDir: dir, auth: { username: 'pve-cu@pve', passwordEnv: 'PVE_CU_TEST_PASSWORD' }, ...extra },
    },
  }));
  return { dir, file };
}

test('config resolves the target, runtime dirs and tls mode', () => {
  const { file, dir } = fixture();
  const config = loadConfig('lab', file);
  assert.equal(config.endpoint, 'https://192.0.2.10:8006');
  assert.equal(config.node, 'pve-node');
  assert.equal(config.vmid, 105);
  assert.equal(config.socketPath, path.join(dir, 'lab', 'daemon.sock'));
  assert.equal(config.framesDir, path.join(dir, 'lab', 'frames'));
  assert.equal(config.imageFormat, 'png');
  assert.equal(config.insecureTls, false);
  assert.deepEqual(config.tlsOptions, {});
  assert.equal(fs.statSync(config.framesDir).mode & 0o777, 0o700);
});

test('config rejects unsafe or incomplete targets', () => {
  assert.throws(() => loadConfig('missing', fixture().file), /Unknown target/);
  assert.throws(() => loadConfig('lab', fixture({ endpoint: 'http://192.0.2.10:8006' }).file), /HTTPS origin/);
  assert.throws(() => loadConfig('lab', fixture({ endpoint: 'https://192.0.2.10:8006/api2/json' }).file), /HTTPS origin/);
  assert.throws(() => loadConfig('lab', fixture({ vmid: 7 }).file), /vmid/);
  assert.throws(() => loadConfig('lab', fixture({ tlsFingerprint: 'zz' }).file), /SHA-256/);
  assert.throws(() => loadConfig('../escape', fixture().file), /valid --target/);
  assert.equal(loadConfig('lab', fixture({ insecureTls: true }).file).insecureTls, true);
});

test('coordinates accept normalised values and pixels', () => {
  assert.equal(coordinate(0, 1920), 0);
  assert.equal(coordinate(0.5, 1920), 960);
  assert.equal(coordinate(1, 1920), 1919);
  assert.equal(coordinate(640, 1920), 640);
  assert.equal(coordinate('0.25', 1080), 270);
  assert.throws(() => coordinate(0.5, 0), /run observe first/);
  assert.throws(() => coordinate(-1, 100), /Invalid coordinate/);
  assert.throws(() => coordinate('x', 100), /Invalid coordinate/);
});
