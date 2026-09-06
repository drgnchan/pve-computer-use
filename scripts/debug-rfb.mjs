#!/usr/bin/env node
// Single-shot debug of the offline RFB path: fake VNC server -> bridge -> Chromium.
import fs from 'node:fs';
import { comboPlan } from '../src/keys.js';
import { ConsoleSession } from '../src/session.js';
import { FakeVncServer } from '../test/fake-vnc-server.mjs';

const CHROME = process.env.PVE_CU_CHROME || '/usr/bin/google-chrome';
if (!fs.existsSync(CHROME)) { console.log('chromium missing:', CHROME); process.exit(1); }

const vnc = new FakeVncServer({ width: 120, height: 80, advertiseQemuExtKey: true });
const url = await vnc.listen();
console.log('[debug] fake vnc on', url);

const session = new ConsoleSession({
  target: 'fake', endpoint: 'https://pve.invalid:8006', node: 'lab', vmid: 105,
  executablePath: CHROME, connectTimeoutMs: 10_000, maxViewport: 3840,
  imageFormat: 'png', jpegQuality: 0.9, insecureTls: false, tlsOptions: {},
}, {
  ticketProvider: async () => ({ upstreamUrl: url, password: 'pv3test!', headers: { Cookie: 'PVEAuthCookie=fake' }, tlsOptions: {}, vmName: 'fake-vm' }),
});

let error = null;
try {
  await session.start();
} catch (caught) {
  error = caught;
}

console.log('[debug] start error:', error ? String(error.message).split('\n')[0] : 'none');
console.log('[debug] vnc.errors:', vnc.errors);
console.log('[debug] vnc.events:', JSON.stringify({
  clientVersion: vnc.events.clientVersion,
  chosenSecurityType: vnc.events.chosenSecurityType,
  authResponseLength: vnc.events.authResponse?.length ?? null,
  sharedFlag: vnc.events.sharedFlag,
  encodings: vnc.events.encodings?.length ?? null,
  updates: vnc.updateCount,
}));
if (!error) {
  console.log('[debug] state:', JSON.stringify(await session.state()));
  const frame = await session.capture();
  console.log('[debug] capture bytes:', Buffer.from(frame.image, 'base64').length, 'size:', frame.width, 'x', frame.height);
  await session.evaluate('keyCombo', { keys: comboPlan('ctrl,l'), delayMs: 2, holdMs: 5 });
  console.log('[debug] qemuKeyEvents:', JSON.stringify(vnc.events.qemuKeyEvents));
  console.log('[debug] keyEvents:', JSON.stringify(vnc.events.keyEvents));
  await session.evaluate('mouse', { type: 'click', x: 10, y: 20, button: 'left' });
  console.log('[debug] pointerEvents:', JSON.stringify(vnc.events.pointerEvents));
}
console.log('[debug] session.pageErrors:', session.pageErrors);
await session.close();
await vnc.close();
process.exit(error ? 1 : 0);
