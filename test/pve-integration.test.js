import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PveApi } from '../src/pve-api.js';
import { hasOpenssl, selfSignedCert } from './helpers.mjs';
import { FAKE_PASSWORD, FAKE_TOKEN_SECRET, FAKE_USERNAME, FakePve } from './fake-pve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'pve-cu.js');
const CHROME = process.env.PVE_CU_CHROME || '/usr/bin/google-chrome';
const skip = !fs.existsSync(CHROME) ? `chromium not found at ${CHROME}` : !hasOpenssl ? 'openssl not installed' : false;

function run(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr,
    }));
  });
}

function json(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}

test('the real CLI + daemon + PVE client drive a console end to end', { skip, timeout: 400_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-e2e-'));
  const pve = new FakePve(selfSignedCert(dir));
  const endpoint = await pve.listen();
  const { fingerprint } = await new PveApi({ endpoint, node: 'lab', vmid: 105, tlsOptions: {} }).peerFingerprint();

  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    executablePath: CHROME,
    targets: {
      lab: { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_FAKE_TOKEN' } },
      'lab-pw': { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { username: FAKE_USERNAME, passwordEnv: 'PVE_CU_FAKE_PASSWORD' } },
      'lab-bad': { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { username: FAKE_USERNAME, passwordEnv: 'PVE_CU_FAKE_BAD_PASSWORD' } },
    },
  }));

  const env = {
    PVE_CU_CONFIG: configFile,
    PVE_CU_FAKE_TOKEN: FAKE_TOKEN_SECRET,
    PVE_CU_FAKE_PASSWORD: FAKE_PASSWORD,
    PVE_CU_FAKE_BAD_PASSWORD: 'definitely-wrong',
  };
  const cli = args => run(['--target', ...args], env);
  t.after(async () => {
    for (const target of ['lab', 'lab-pw', 'lab-bad']) await run(['--target', target, 'daemon', 'stop'], env);
    await pve.close();
  });

  // --- setup checks ------------------------------------------------------
  const tls = json(await cli(['lab', 'tlscheck']));
  assert.equal(tls.ok, true);
  assert.equal(tls.tlsMode, 'pinned-fingerprint');
  assert.deepEqual(tls.realms, ['pam', 'pve']);

  // --- screenshot through the whole stack --------------------------------
  const observe = json(await cli(['lab', 'observe']));
  assert.equal(observe.width, 160, `observe failed: ${observe.error || ''}`);
  assert.equal(observe.height, 100);
  assert.ok(fs.existsSync(observe.filePath));
  assert.equal(fs.readFileSync(observe.filePath).subarray(1, 4).toString(), 'PNG');
  assert.equal(path.dirname(path.dirname(observe.filePath)), path.join(dir, 'lab'));

  const status = json(await cli(['lab', 'status']));
  assert.equal(status.connected, true);
  assert.equal(status.authMethod, 'api-token');
  assert.equal(status.vmName, 'fake-vm');
  assert.equal(status.tlsMode, 'pinned-fingerprint');
  assert.equal(status.sandboxDisabled, false);
  assert.deepEqual(status.pageErrors, []);
  assert.ok(status.framebufferUpdates >= 1);

  // PVE requires API auth on the websocket upgrade, not just the vnc ticket.
  assert.equal(pve.records.wsUpgrades.length, 1);
  assert.equal(pve.records.wsUpgrades[0].auth, 'api-token');
  assert.equal(pve.records.wsUpgrades[0].protocol, 'binary');
  assert.match(pve.records.wsUpgrades[0].authorization, /^PVEAPIToken=pve-cu@pve!console=/);
  assert.equal(pve.records.unauthenticated, 0);
  assert.deepEqual(pve.records.vncproxyRequests[0].body, { websocket: '1' });

  // --- mouse -------------------------------------------------------------
  const click = json(await cli(['lab', 'click', '--x', '0.5', '--y', '0.5']));
  assert.equal(click.executed, 'click');
  assert.deepEqual(pve.vnc.events.pointerEvents.slice(-2), [
    { mask: 1, x: 80, y: 50 }, { mask: 0, x: 80, y: 50 },
  ]);

  const right = json(await cli(['lab', 'click', '--x', '10', '--y', '20', '--button', 'right']));
  assert.equal(right.button, 'right');
  assert.deepEqual(pve.vnc.events.pointerEvents.slice(-2), [
    { mask: 4, x: 10, y: 20 }, { mask: 0, x: 10, y: 20 },
  ]);

  await cli(['lab', 'scroll', '--x', '0.5', '--y', '0.5', '--dy', '-2']);
  assert.ok(pve.vnc.events.pointerEvents.slice(-6).some(event => event.mask === 8), 'dy < 0 must scroll up');

  const drag = json(await cli(['lab', 'drag', '--from-x', '0', '--from-y', '0', '--to-x', '40', '--to-y', '60']));
  assert.equal(drag.executed, 'drag');
  assert.deepEqual(pve.vnc.events.pointerEvents.at(-1), { mask: 0, x: 40, y: 60 });

  // --- keyboard ----------------------------------------------------------
  const combo = json(await cli(['lab', 'key', '--keys', 'ctrl,l']));
  assert.equal(combo.keys, 'ControlLeft+KeyL');
  assert.deepEqual(pve.vnc.events.qemuKeyEvents.slice(0, 4).map(event => [event.keysym, event.keycode, event.down]), [
    [0xffe3, 0x1d, true], [0x6c, 0x26, true], [0x6c, 0x26, false], [0xffe3, 0x1d, false],
  ]);
  assert.equal(pve.vnc.events.keyEvents.length, 0, 'QEMU extended key events must be used');

  const typed = json(await cli(['lab', 'type', '--text', 'hi A1']));
  assert.equal(typed.typed, 5);
  assert.deepEqual(pve.vnc.events.qemuKeyEvents.slice(4).map(event => event.keysym), [
    0x68, 0x68,                                   // h
    0x69, 0x69,                                   // i
    0x20, 0x20,                                   // space
    0xffe1, 0x41, 0x41, 0xffe1,                   // Shift + A
    0x31, 0x31,                                   // 1
  ]);

  const reset = json(await cli(['lab', 'reset']));
  assert.equal(reset.executed, 'reset');

  // Secret-safe typing: the text comes from a file, never from argv.
  const secretFile = path.join(dir, 'secret.txt');
  fs.writeFileSync(secretFile, 'ok\n', { mode: 0o600 });
  const fromFile = json(await cli(['lab', 'type', '--from-file', secretFile]));
  assert.equal(fromFile.typed, 2, `type --from-file failed: ${fromFile.error || ''}`);
  assert.deepEqual(pve.vnc.events.qemuKeyEvents.slice(-4).map(event => event.keysym), [0x6f, 0x6f, 0x6b, 0x6b]);

  // --- rejection paths ---------------------------------------------------
  const outOfRange = await cli(['lab', 'click', '--x', '9999', '--y', '1']);
  assert.equal(outOfRange.exitCode, 1);
  assert.match(outOfRange.stderr, /outside the 160px framebuffer/);

  const nonAscii = await cli(['lab', 'type', '--text', '你好']);
  assert.equal(nonAscii.exitCode, 1);
  assert.match(nonAscii.stderr, /ASCII only/);

  const badCredentials = await cli(['lab-bad', 'observe']);
  assert.equal(badCredentials.exitCode, 1);
  assert.match(badCredentials.stderr, /PVE rejected the request \(401\)/);
  // The daemon is up but every attempt fails the same way: no half-open session.
  assert.equal(fs.existsSync(path.join(dir, 'lab-bad', 'daemon.sock')), true);
  const badStatus = await cli(['lab-bad', 'status']);
  assert.equal(badStatus.exitCode, 1);
  assert.match(badStatus.stderr, /PVE rejected the request \(401\)/);

  // --- ticket (username/password) authentication --------------------------
  const ticketObserve = json(await cli(['lab-pw', 'observe']));
  assert.equal(ticketObserve.width, 160, `ticket auth observe failed: ${ticketObserve.error || ''}`);
  const ticketStatus = json(await cli(['lab-pw', 'status']));
  assert.equal(ticketStatus.authMethod, 'ticket');
  const proxyWithTicket = pve.records.vncproxyRequests.find(request => request.auth === 'ticket');
  assert.ok(proxyWithTicket, 'the ticket session must call vncproxy');
  assert.match(proxyWithTicket.csrf, /^[0-9A-F]+$/, 'POST vncproxy must carry the CSRF prevention token');
  const logins = pve.records.loginBodies;
  assert.equal(logins.filter(login => login.passwordOk).length, 1, 'exactly one login may succeed');
  assert.equal(logins.find(login => login.passwordOk).username, FAKE_USERNAME);
  assert.ok(logins.some(login => !login.passwordOk), 'the wrong password attempt must have been rejected');

  // --- daemon lifecycle --------------------------------------------------
  const stopped = json(await cli(['lab', 'daemon', 'stop']));
  assert.equal(stopped.ok, true);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(path.join(dir, 'lab', 'daemon.sock')), false, 'the socket must be removed on shutdown');
});

test('doctor reports a progressive setup checklist', { skip, timeout: 400_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-doctor-'));
  const pve = new FakePve(selfSignedCert(dir));
  const endpoint = await pve.listen();
  const { fingerprint } = await new PveApi({ endpoint, node: 'lab', vmid: 105, tlsOptions: {} }).peerFingerprint();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    executablePath: CHROME,
    targets: { lab: { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_FAKE_TOKEN' } } },
  }));
  const env = { PVE_CU_CONFIG: configFile, PVE_CU_FAKE_TOKEN: FAKE_TOKEN_SECRET };
  t.after(async () => { await run(['--target', 'lab', 'daemon', 'stop'], env); await pve.close(); });

  const check = (report, name) => report.checks.find(entry => entry.name === name);

  // No credentials are sent by the plain check.
  const plain = json(await run(['--target', 'lab', 'doctor'], env));
  assert.equal(plain.ok, true, JSON.stringify(plain.checks));
  assert.deepEqual(plain.checks.map(entry => entry.name), ['config', 'bundle', 'chromium', 'tls', 'api', 'credentials', 'daemon']);
  assert.equal(check(plain, 'tls').ok, true);
  assert.match(check(plain, 'tls').detail, new RegExp(fingerprint.slice(0, 12)));
  assert.equal(check(plain, 'credentials').ok, true);
  assert.match(check(plain, 'credentials').detail, /value not shown/);
  assert.equal(check(plain, 'daemon').ok, true, 'an unstarted daemon is not a failure');
  assert.equal(pve.records.loginBodies.length, 0, 'the plain check must not log in');

  const withAuth = json(await run(['--target', 'lab', 'doctor', '--auth'], env));
  assert.equal(withAuth.ok, true, JSON.stringify(withAuth.checks));
  assert.equal(check(withAuth, 'auth').ok, true);
  assert.match(check(withAuth, 'auth').detail, /api-token login accepted; VMID 105 "fake-vm" is running/);
  assert.equal(check(withAuth, 'vm-running').ok, true);

  const withConsole = json(await run(['--target', 'lab', 'doctor', '--console'], env));
  assert.equal(withConsole.ok, true, JSON.stringify(withConsole.checks));
  assert.equal(check(withConsole, 'console').ok, true);
  assert.match(check(withConsole, 'console').detail, /frame 160x100 saved to /);
  assert.equal(check(withConsole, 'daemon').ok, true);
});

test('doctor flags a missing secret and an unpinned certificate', { skip: !hasOpenssl, timeout: 200_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-doctor-bad-'));
  const pve = new FakePve(selfSignedCert(dir));
  const endpoint = await pve.listen();
  t.after(async () => pve.close());
  const configFile = path.join(dir, 'config.json');
  // Deliberately unpinned and without the secret in the environment.
  fs.writeFileSync(configFile, JSON.stringify({
    executablePath: CHROME,
    targets: { lab: { endpoint, node: 'lab', vmid: 105, cacheDir: dir, auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_MISSING_TOKEN' } } },
  }));
  const env = { PVE_CU_CONFIG: configFile };

  const result = await run(['--target', 'lab', 'doctor'], env);
  assert.equal(result.exitCode, 1);
  const report = json(result);
  assert.equal(report.ok, false);
  const check = name => report.checks.find(entry => entry.name === name);
  assert.equal(check('tls').ok, false);
  assert.match(check('tls').detail, /is not pinned/);
  assert.match(check('tls').hint, /tlsFingerprint/);
  assert.equal(check('api').ok, false, 'an unpinned certificate must also block the API call');
  assert.equal(check('credentials').ok, false);
  assert.match(check('credentials').hint, /export PVE_CU_MISSING_TOKEN=/);
  assert.equal(pve.records.statusRequests, 0);
});

test('older PVE without the vncproxy password field still opens a console', { skip, timeout: 300_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-oldpve-'));
  const pve = new FakePve({ ...selfSignedCert(dir), omitVncPasswordField: true });
  const endpoint = await pve.listen();
  const { fingerprint } = await new PveApi({ endpoint, node: 'lab', vmid: 105, tlsOptions: {} }).peerFingerprint();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    executablePath: CHROME,
    targets: { lab: { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_FAKE_TOKEN' } } },
  }));
  const env = { PVE_CU_CONFIG: configFile, PVE_CU_FAKE_TOKEN: FAKE_TOKEN_SECRET };
  t.after(async () => { await run(['--target', 'lab', 'daemon', 'stop'], env); await pve.close(); });

  const observeResult = await run(['--target', 'lab', 'observe'], env);
  const observe = json(observeResult);
  assert.equal(observe?.width, 160, `observe failed: ${observeResult.stderr || observeResult.stdout}`);
  assert.equal(observe.height, 100);

  // The RFB password must be the 8 character ticket prefix, so the VNC auth
  // handshake succeeds and input reaches the guest.
  assert.equal(pve.vnc.events.authResponse?.length, 16);
  await run(['--target', 'lab', 'click', '--x', '0.5', '--y', '0.5'], env);
  assert.deepEqual(pve.vnc.events.pointerEvents.slice(-2), [
    { mask: 1, x: 80, y: 50 }, { mask: 0, x: 80, y: 50 },
  ]);
});

test('a stopped VM is reported instead of opening a console', { skip, timeout: 200_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-cu-stopped-'));
  const pve = new FakePve({ ...selfSignedCert(dir), running: false });
  const endpoint = await pve.listen();
  const { fingerprint } = await new PveApi({ endpoint, node: 'lab', vmid: 105, tlsOptions: {} }).peerFingerprint();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    executablePath: CHROME,
    targets: { off: { endpoint, node: 'lab', vmid: 105, cacheDir: dir, tlsFingerprint: fingerprint, auth: { tokenId: 'pve-cu@pve!console', tokenSecretEnv: 'PVE_CU_FAKE_TOKEN' } } },
  }));
  const env = { PVE_CU_CONFIG: configFile, PVE_CU_FAKE_TOKEN: FAKE_TOKEN_SECRET };
  t.after(async () => { await run(['--target', 'off', 'daemon', 'stop'], env); await pve.close(); });

  const result = await run(['--target', 'off', 'observe'], env);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /VMID 105 is not running \(state: stopped\)/);
  assert.equal(pve.records.wsUpgrades.length, 0, 'no console must be opened for a stopped VM');
});
