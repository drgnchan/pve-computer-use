import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.js';

test('command and target are recognised in any order', () => {
  assert.deepEqual(parseArgs(['--target', 'lab', 'observe']), { command: 'observe', positional: [], options: { target: 'lab' } });
  assert.deepEqual(parseArgs(['observe', '--target', 'lab']), { command: 'observe', positional: [], options: { target: 'lab' } });
  assert.deepEqual(parseArgs(['-t', 'lab', 'click', '--x', '0.5']), { command: 'click', positional: [], options: { target: 'lab', x: '0.5' } });
  assert.equal(parseArgs([]).command, 'status', 'no command defaults to status');
  assert.deepEqual(parseArgs(['daemon', 'stop']).positional, ['stop']);
});

test('negative numbers stay values instead of becoming flags', () => {
  assert.deepEqual(parseArgs(['scroll', '--dy', '-2']).options, { dy: '-2' });
  assert.deepEqual(parseArgs(['scroll', '--dy=-3']).options, { dy: '-3' });
  assert.deepEqual(parseArgs(['scroll', '--dy', '-0.5', '--x', '0.5']).options, { dy: '-0.5', x: '0.5' });
});

test('dash prefixed text needs the = form, flags stay boolean', () => {
  assert.deepEqual(parseArgs(['type', '--text=-v']).options, { text: '-v' });
  assert.deepEqual(parseArgs(['type', '--text', '-v']).options, { text: true, v: true }, 'documented ambiguity');
  assert.deepEqual(parseArgs(['status', '--help']).options, { help: true });
  assert.deepEqual(parseArgs(['key', '--keys', 'ctrl,l']).options, { keys: 'ctrl,l' });
  assert.deepEqual(parseArgs(['type', '--text', 'a b']).options, { text: 'a b' });
});

test('everything after -- is positional', () => {
  const parsed = parseArgs(['type', '--', '--text', 'x']);
  assert.equal(parsed.command, 'type');
  assert.deepEqual(parsed.positional, ['--text', 'x']);
  assert.deepEqual(parsed.options, {});
});
