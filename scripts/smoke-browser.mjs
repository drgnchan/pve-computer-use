#!/usr/bin/env node
// Offline smoke test: real headless Chromium + built bundle + bridge, but no PVE.
// The fake upstream accepts the WebSocket and stays silent, so the RFB handshake
// must time out; this verifies browser launch, page load and the adapter API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { ConsoleBridge } from '../src/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
if (!fs.existsSync(path.join(webRoot, 'dist/console.bundle.js'))) throw new Error('run `npm run build` first');

const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => upstream.once('listening', resolve));

const bridge = await new ConsoleBridge({
  upstreamUrl: `ws://127.0.0.1:${upstream.address().port}/fake-console`,
  headers: { Cookie: 'PVEAuthCookie=smoke' },
  webRoot,
  onUpstreamClosed: reason => console.log('[smoke] upstream closed:', reason),
}).start();

const args = ['--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--no-first-run', '--disable-background-networking'];
let sandboxDisabled = false;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args });
} catch (error) {
  sandboxDisabled = true;
  console.log('[smoke] relaunching without sandbox:', error.message.split('\n')[0]);
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: [...args, '--no-sandbox', '--disable-setuid-sandbox'] });
}

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error.stack || error.message)));
page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });

await page.goto(bridge.pageUrl, { waitUntil: 'load' });
const api = await page.evaluate(() => Object.keys(window.pveConsole || {}).sort());
console.log('[smoke] adapter api:', api.join(','));
await page.evaluate(({ url, password }) => window.pveConsole.startConsole({ url, password }), { url: bridge.rfbUrl, password: 'smokepwd' });

let state;
for (let i = 0; i < 20; i++) {
  state = await page.evaluate(() => window.pveConsole.consoleState());
  if (state.failure) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
console.log('[smoke] state:', JSON.stringify(state));
console.log('[smoke] pageErrors:', pageErrors.length ? pageErrors.slice(0, 3) : 'none');
console.log('[smoke] sandboxDisabled:', sandboxDisabled);

let captureError = null;
try { await page.evaluate(() => window.pveConsole.captureFrame({ format: 'png' })); } catch (error) { captureError = String(error.message); }
console.log('[smoke] capture before connect:', captureError);

const released = await page.evaluate(() => window.pveConsole.releaseAll({}));
console.log('[smoke] releaseAll:', JSON.stringify(released));

await context.close();
await browser.close();
await bridge.close();
upstream.close();

const ok = api.includes('captureFrame') && api.includes('mouse') && !pageErrors.length && state.connected === false && Boolean(captureError);
console.log(ok ? '[smoke] PASS: browser + bundle + adapter wiring works (no PVE involved)' : '[smoke] FAIL');
process.exit(ok ? 0 : 1);
