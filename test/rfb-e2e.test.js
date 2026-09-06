import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { comboPlan, textPlan } from '../src/keys.js';
import { ConsoleSession } from '../src/session.js';
import { FakeVncServer } from './fake-vnc-server.mjs';

const CHROME = process.env.PVE_CU_CHROME || '/usr/bin/google-chrome';
const skip = fs.existsSync(CHROME) ? false : `chromium not found at ${CHROME}`;

const sessionConfig = {
  target: 'fake', endpoint: 'https://pve.invalid:8006', node: 'lab', vmid: 105,
  executablePath: CHROME, connectTimeoutMs: 30_000, maxViewport: 3840,
  imageFormat: 'png', jpegQuality: 0.9, insecureTls: false, tlsOptions: {},
};

function pngInfo(base64) {
  const buffer = Buffer.from(base64, 'base64');
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'PNG magic');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

async function withSession(t, options, body) {
  const vnc = new FakeVncServer(options);
  const url = await vnc.listen();
  const session = new ConsoleSession(sessionConfig, {
    ticketProvider: async () => ({ upstreamUrl: url, password: 'pv3test!', headers: { Cookie: 'PVEAuthCookie=fake' }, tlsOptions: {}, vmName: 'fake-vm' }),
  });
  await session.start();
  t.after(async () => { await session.close(); await vnc.close(); });
  return await body(session, vnc);
}

test('console session completes RFB auth, captures the framebuffer and injects input', { skip, timeout: 180_000 }, async t => {
  await withSession(t, { width: 120, height: 80, advertiseQemuExtKey: true }, async (session, vnc) => {
    // --- handshake -------------------------------------------------------
    assert.equal(vnc.events.chosenSecurityType, 2, 'client must pick VNC auth like PVE expects');
    assert.equal(vnc.events.authResponse.length, 16, 'the configured RFB password must be used for the challenge');
    assert.match(vnc.events.clientVersion, /^RFB 003\.00/);
    assert.ok(vnc.events.encodings.length > 3);

    const state = await session.state();
    assert.equal(state.connected, true);
    assert.equal(state.width, 120);
    assert.equal(state.height, 80);
    assert.equal(state.vmName, 'fake-vm');
    assert.equal(state.failure, null);
    assert.ok(state.framebufferUpdates >= 1);

    // --- screenshot ------------------------------------------------------
    const frame = await session.capture();
    assert.deepEqual(pngInfo(frame.image), { width: 120, height: 80, bytes: pngInfo(frame.image).bytes });
    assert.equal(frame.width, 120);
    assert.equal(session.framebuffer.width, 120, 'viewport must follow the framebuffer size');

    // --- mouse -----------------------------------------------------------
    await session.evaluate('mouse', { type: 'click', x: 10, y: 20, button: 'left' });
    const clicks = vnc.events.pointerEvents;
    assert.deepEqual(clicks.at(-2), { mask: 1, x: 10, y: 20 });
    assert.deepEqual(clicks.at(-1), { mask: 0, x: 10, y: 20 });

    await session.evaluate('mouse', { type: 'click', x: 119, y: 79, button: 'right' });
    assert.deepEqual(vnc.events.pointerEvents.at(-2), { mask: 4, x: 119, y: 79 });

    const before = vnc.events.pointerEvents.length;
    await session.evaluate('mouse', { type: 'scroll', x: 5, y: 5, dy: -2 });
    const scrolled = vnc.events.pointerEvents.slice(before);
    assert.ok(scrolled.some(event => event.mask === 8), 'dy < 0 must send wheel-up (mask bit 3)');
    assert.ok(scrolled.every(event => event.x === 5 && event.y === 5));

    await session.evaluate('mouse', { type: 'drag', x: 0, y: 0, toX: 30, toY: 40, button: 'left', steps: 3 });
    const dragged = vnc.events.pointerEvents.slice(before + scrolled.length);
    assert.equal(dragged[0].mask, 1);
    assert.deepEqual(dragged.at(-1), { mask: 0, x: 30, y: 40 });

    // --- keyboard (QEMU extended key events) -----------------------------
    await session.evaluate('keyCombo', { keys: comboPlan('ctrl,l'), delayMs: 2, holdMs: 5 });
    const combos = vnc.events.qemuKeyEvents;
    assert.deepEqual(combos.slice(0, 4).map(event => [event.keysym, event.keycode, event.down]), [
      [0xffe3, 0x1d, true],   // ControlLeft down
      [0x6c, 0x26, true],     // KeyL down
      [0x6c, 0x26, false],    // KeyL up
      [0xffe3, 0x1d, false],  // ControlLeft up
    ]);
    assert.equal(vnc.events.keyEvents.length, 0, 'codes must be valid so noVNC uses the scancode path');

    await session.evaluate('keyCombo', { keys: comboPlan('up'), delayMs: 2, holdMs: 5 });
    assert.deepEqual(vnc.events.qemuKeyEvents.at(-2), { down: true, keysym: 0xff52, keycode: 0xc8 });

    const beforeTyping = vnc.events.qemuKeyEvents.length;   // combos is a live reference
    await session.evaluate('typeChars', { chars: textPlan('aB1'), delayMs: 2 });
    const typed = vnc.events.qemuKeyEvents.slice(beforeTyping);
    assert.deepEqual(typed.map(event => [event.keysym, event.down]), [
      [0x61, true], [0x61, false],                       // a
      [0xffe1, true], [0x42, true], [0x42, false], [0xffe1, false], // Shift + B
      [0x31, true], [0x31, false],                       // 1
    ]);
    assert.deepEqual(typed.map(event => event.keycode), [0x1e, 0x1e, 0x2a, 0x30, 0x30, 0x2a, 0x02, 0x02]);

    // --- reset releases held keys ---------------------------------------
    const held = await session.evaluate('keyCombo', { keys: comboPlan('shift'), delayMs: 2, holdMs: 5 });
    assert.equal(held.executed, 'key');
    const status = await session.evaluate('consoleState');
    assert.equal(status.heldKeys, 0, 'a completed combo must not leave keys held');
    const released = await session.evaluate('releaseAll', {});
    assert.equal(released.executed, 'reset');
    assert.equal(released.releasedKeys, 0);
    assert.ok(released.framebufferUpdates >= 1, 'actions report the frame counter so the daemon can baseline --wait-change');
  });
});

test('plain KeyEvent path works when the server does not advertise QEMU extensions', { skip, timeout: 180_000 }, async t => {
  await withSession(t, { width: 64, height: 48 }, async (session, vnc) => {
    await session.evaluate('keyCombo', { keys: comboPlan('Enter'), delayMs: 2, holdMs: 5 });
    assert.deepEqual(vnc.events.keyEvents, [
      { down: true, keysym: 0xff0d },
      { down: false, keysym: 0xff0d },
    ]);
    assert.equal(vnc.events.qemuKeyEvents.length, 0);

    // Out of range coordinates must be rejected before anything is sent.
    const before = vnc.events.pointerEvents.length;
    await assert.rejects(() => session.evaluate('mouse', { type: 'click', x: 64, y: 0 }), /outside/);
    assert.equal(vnc.events.pointerEvents.length, before);
  });
});

test('decoded framebuffer pixels keep the guest colour order', { skip, timeout: 180_000 }, async t => {
  // The fake server paints four known quadrants; reading them back from the
  // decoded canvas proves the wire byte order matches QEMU (R,G,B,X for a
  // little-endian 32bpp format). A red/blue swap would fail here.
  await withSession(t, { width: 64, height: 48, pattern: 'quadrants' }, async session => {
    const pixels = await session.page.evaluate(() => {
      const image = window.__rfb.getImageData();
      const at = (x, y) => {
        const index = (y * image.width + x) * 4;
        return [image.data[index], image.data[index + 1], image.data[index + 2]];
      };
      return {
        topLeft: at(4, 4),
        topRight: at(image.width - 5, 4),
        bottomLeft: at(4, image.height - 5),
        bottomRight: at(image.width - 5, image.height - 5),
      };
    });
    assert.deepEqual(pixels.topLeft, [255, 0, 0], 'top-left must stay red');
    assert.deepEqual(pixels.topRight, [0, 255, 0], 'top-right must stay green');
    assert.deepEqual(pixels.bottomLeft, [0, 0, 255], 'bottom-left must stay blue');
    assert.deepEqual(pixels.bottomRight, [255, 255, 255], 'bottom-right must stay white');
  });
});

test('a capture is complete even when the first update only carries damaged regions', { skip, timeout: 180_000 }, async t => {
  await withSession(t, { width: 64, height: 48, pattern: 'quadrants', partialFirstUpdate: true }, async session => {
    const frame = await session.capture();
    assert.equal(frame.fullFrame, true, 'the capture must wait for a guaranteed full-frame update');
    const pixels = await session.page.evaluate(() => {
      const image = window.__rfb.getImageData();
      const at = (x, y) => {
        const index = (y * image.width + x) * 4;
        return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
      };
      return { bottomLeft: at(4, image.height - 5), topRight: at(image.width - 5, 4) };
    });
    assert.deepEqual(pixels.bottomLeft.slice(0, 3), [0, 0, 255], 'the bottom half must be drawn after the full-frame request');
    assert.equal(pixels.bottomLeft[3], 255, 'undrawn (transparent) pixels must not survive');
    assert.deepEqual(pixels.topRight.slice(0, 3), [0, 255, 0]);
  });
});

test('waitForChange returns on a server push and times out on a static screen', { skip, timeout: 180_000 }, async t => {
  await withSession(t, { width: 64, height: 48, maxUpdates: 2 }, async (session, vnc) => {
    const settled = await session.evaluate('consoleState');
    assert.ok(settled.framebufferUpdates >= 1);

    // Nothing more is coming: the wait must expire and report no change.
    const idle = await session.evaluate('waitForChange', { baseline: settled.framebufferUpdates, timeoutMs: 400 });
    assert.equal(idle.changed, false);
    assert.equal(idle.baselineUpdates, settled.framebufferUpdates);
    assert.ok(idle.waitedMs >= 350, `waited ${idle.waitedMs}ms`);

    // A real redraw must wake the wait immediately.
    const pending = session.evaluate('waitForChange', { baseline: settled.framebufferUpdates, timeoutMs: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await vnc.pushUpdate({ r: 12, g: 200, b: 90 }), true);
    const result = await pending;
    assert.equal(result.changed, true);
    assert.ok(result.framebufferUpdates > settled.framebufferUpdates);
    assert.ok(result.waitedMs >= 200 && result.waitedMs < 6_000, `waited ${result.waitedMs}ms`);

    // The new content must be visible in the next screenshot.
    const frame = await session.capture();
    assert.equal(frame.width, 64);
    assert.ok(Buffer.from(frame.image, 'base64').length > 100);
  });
});

test('a rejected RFB authentication surfaces as a console failure', { skip, timeout: 180_000 }, async t => {
  const vnc = new FakeVncServer({ width: 64, height: 48, rejectAuth: true });
  const url = await vnc.listen();
  t.after(async () => { await vnc.close(); });
  const session = new ConsoleSession({ ...sessionConfig, connectTimeoutMs: 8_000 }, {
    ticketProvider: async () => ({ upstreamUrl: url, password: 'wrong-password', headers: {}, tlsOptions: {}, vmName: 'fake-vm' }),
  });
  t.after(async () => { await session.close(); });
  await assert.rejects(() => session.start(), /security failure|Console connection failed/);
  assert.equal(vnc.events.authResponse?.length, 16, 'the client must still answer the challenge');
});
