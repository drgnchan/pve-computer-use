/** Bounded redraw-quiescence heuristic, NOT a guarantee of UI readiness.
 * A blinking caret/clock can prevent quiescence; always return the final frame.
 */
export async function waitForStable({ readState, assertConnected, baseline = 0,
  timeoutMs = 5000, stableMs = 800, minWaitMs = 1500,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const started = now();
  let last = readState().framebufferUpdates;
  let quietSince = started;
  while (true) {
    assertConnected();
    const updates = readState().framebufferUpdates;
    const time = now();
    if (updates !== last) { last = updates; quietSince = time; }
    const waitedMs = time - started;
    const stable = waitedMs >= minWaitMs && time - quietSince >= stableMs;
    if (stable || waitedMs >= timeoutMs) {
      return { changed: updates > baseline, stable, timedOut: !stable,
        waitedMs, baselineUpdates: baseline, framebufferUpdates: updates };
    }
    await sleep(Math.min(80, timeoutMs - waitedMs));
  }
}
