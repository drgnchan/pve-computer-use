import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ACTIONS = ['observe', 'click', 'double-click', 'move', 'scroll', 'key', 'type', 'reset'];

export function toolArgs(p) {
  if (!/^[a-zA-Z0-9_-]+$/.test(p.target || '')) throw new Error('Invalid target');
  if (!ACTIONS.includes(p.action)) throw new Error('Unsupported action');
  if (p.text !== undefined && p.fromFile !== undefined) throw new Error('Choose text OR fromFile');
  if (p.action === 'type' && p.text === undefined && p.fromFile === undefined) throw new Error('type needs text or fromFile');
  const args = ['--target', p.target, p.action];
  for (const key of ['x', 'y', 'dy', 'button', 'keys', 'text']) {
    if (p[key] !== undefined) args.push(`--${key}=${p[key]}`);
  }
  if (p.fromFile !== undefined) {
    const file = p.fromFile.replace(/^@/, '').replace(/^~\//, `${os.homedir()}/`);
    if (!path.isAbsolute(file)) throw new Error('fromFile must be absolute or ~/...');
    args.push('--from-file', file); // Never read credentials in this extension.
  }
  if (p.action !== 'observe') args.push('--observe');
  const wait = p.wait ?? (p.action === 'observe' ? 'none' : 'stable');
  if (!['none', 'change', 'stable'].includes(wait)) throw new Error('Invalid wait mode');
  if (wait !== 'none') args.push(`--wait-${wait}`);
  for (const [key, flag] of [['waitTimeoutMs', 'wait-timeout'], ['stableMs', 'stable-ms'], ['minWaitMs', 'min-wait']]) {
    if (p[key] !== undefined) {
      if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 120000) throw new Error('Invalid wait duration');
      args.push(`--${flag}`, String(p[key]));
    }
  }
  return args;
}

/** exec is Pi's captured subprocess helper; injectable for offline tests. */
export async function runPiConsole(p, { exec, signal, readFile = fs.readFile }) {
  const args = toolArgs(p);
  signal?.throwIfAborted();
  const started = Date.now();
  let response;
  try {
    response = await exec('pve-cu', args, { signal, timeout: 300000 });
  } catch {
    // Cancellation/transport failure does not undo a daemon input action.
    throw new Error('pve-cu transport failed; action outcome is unknown. Observe before retrying any input.');
  }
  if (response.code !== 0 || response.killed) {
    // Do not echo argv/stderr: a future transport error could contain typed text.
    throw new Error('pve-cu did not complete normally. Input may have executed; run observe and doctor before retrying.');
  }
  let data;
  try { data = JSON.parse(response.stdout); }
  catch { throw new Error('Invalid pve-cu response; input outcome unknown. Observe before retrying.'); }
  const cliMs = Date.now() - started;
  const frame = p.action === 'observe' ? data : data.frame;
  const content = [];
  let imageError;
  if (frame?.filePath) {
    try {
      if (frame.target !== p.target || !/^frame_[\w-]+\.(png|jpg)$/.test(path.basename(frame.filePath))) {
        throw new Error('Invalid screenshot identity');
      }
      const image = await readFile(frame.filePath);
      const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = image[0] === 255 && image[1] === 216 && image[2] === 255;
      if ((!png && !jpeg) || image.length > 20 * 1024 * 1024) throw new Error('Invalid screenshot');
      content.push({ type: 'image', data: image.toString('base64'), mimeType: png ? 'image/png' : 'image/jpeg' });
    } catch {
      imageError = 'Screenshot attachment failed. Do not repeat input; use observe to inspect current state.';
    }
  } else {
    imageError = 'No screenshot returned. Do not repeat input; check daemon version and use observe.';
  }
  const details = { ...data, ...(imageError ? { imageError } : {}), cliMs, toolTotalMs: Date.now() - started };
  const text = JSON.stringify(details);
  content.unshift({ type: 'text', text: text.length > 16000 ? text.slice(0, 16000) + '\n[metadata truncated]' : text });
  return { content, details };
}
