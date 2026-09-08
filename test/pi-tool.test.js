import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolArgs, runPiConsole } from '../src/pi-tool.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');
const frame = { filePath: '/mock/frame_test.png', target: 'lab', width: 1, height: 1 };

test('password path travels as argv, never password contents; no shell interpolation', () => {
  const args = toolArgs({ target: 'lab', action: 'type', fromFile: '/mock/password' });
  assert.ok(args.includes('--from-file'));
  assert.ok(args.includes('--observe'));
  assert.ok(args.includes('--wait-stable'));
  assert.ok(!args.some(a => a.startsWith('--text')));
  assert.ok(toolArgs({ target: 'lab', action: 'type', text: '-$(unsafe)' }).includes('--text=-$(unsafe)'));
  assert.throws(() => toolArgs({ target: 'lab', action: 'type', text: 'a', fromFile: '/mock' }));
});
test('one action produces inline image without a second tool call', async () => {
  let count = 0;
  const r = await runPiConsole({ target: 'lab', action: 'click', x: 0.5, y: 0.5 }, {
    exec: async () => { count++; return { code: 0, stdout: JSON.stringify({ executed: 'click', frame }) }; },
    readFile: async file => { assert.equal(file, frame.filePath); return png; },
  });
  assert.equal(count, 1);
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/png');
  assert.ok(r.details.cliMs >= 0);
});
test('attachment failure preserves action result and does not retry', async () => {
  let count = 0;
  const r = await runPiConsole({ target: 'lab', action: 'key', keys: 'Enter' }, {
    exec: async () => { count++; return { code: 0, stdout: JSON.stringify({ executed: 'key', frame }) }; },
    readFile: async () => { throw new Error('missing'); },
  });
  assert.equal(count, 1);
  assert.equal(r.details.executed, 'key');
  assert.match(r.details.imageError, /Do not repeat input/);
});
test('wrong target image is refused before any file read', async () => {
  const r = await runPiConsole({ target: 'lab', action: 'observe' }, {
    exec: async () => ({ code: 0, stdout: JSON.stringify({ ...frame, target: 'other' }) }),
    readFile: async () => { assert.fail('must not read'); },
  });
  assert.ok(r.details.imageError);
});
test('transport failure neither retries nor echoes potentially sensitive error', async () => {
  await assert.rejects(runPiConsole({ target: 'lab', action: 'observe' }, {
    exec: async () => { throw new Error('sensitive stdout'); },
  }), error => /outcome is unknown/.test(error.message) && !error.message.includes('sensitive'));
});
