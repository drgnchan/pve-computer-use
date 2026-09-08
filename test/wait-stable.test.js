import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForStable } from '../web/wait-stable.js';

async function simulate(updates, options = {}) {
  let time = 0;
  return waitForStable({
    readState: () => ({ framebufferUpdates: updates(time) }),
    assertConnected() {}, now: () => time,
    sleep: async ms => { time += ms; }, baseline: 5, ...options,
  });
}

test('stable waiting does not return on the first selection/animation frame', async () => {
  const r = await simulate(t => t < 900 ? 6 : 7);
  assert.equal(r.stable, true);
  assert.equal(r.changed, true);
  assert.ok(r.waitedMs >= 1700);
});
test('static screen completes after minimum observation time without claiming change', async () => {
  const r = await simulate(() => 5);
  assert.equal(r.stable, true);
  assert.equal(r.changed, false);
  assert.ok(r.waitedMs >= 1500);
});
test('continuous redraws/caret blinking have a bounded timeout', async () => {
  const r = await simulate(t => 5 + Math.floor(t / 400), { timeoutMs: 2500 });
  assert.equal(r.stable, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.waitedMs, 2500);
});
test('zero timeout returns immediately', async () => {
  const r = await simulate(() => 5, { timeoutMs: 0 });
  assert.equal(r.waitedMs, 0);
  assert.equal(r.stable, false);
});
test('disconnects fail rather than looking like a static healthy screen', async () => {
  await assert.rejects(waitForStable({ readState: () => ({ framebufferUpdates: 5 }),
    assertConnected() { throw new Error('disconnected'); },
  }), /disconnected/);
});
