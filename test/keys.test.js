import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charPlan, comboPlan, textPlan } from '../src/keys.js';

test('letters map to keysym + DOM code with shift only for uppercase', () => {
  assert.deepEqual(charPlan('a'), { keysym: 0x61, code: 'KeyA', shift: false });
  assert.deepEqual(charPlan('Z'), { keysym: 0x5a, code: 'KeyZ', shift: true });
  assert.deepEqual(charPlan('5'), { keysym: 0x35, code: 'Digit5', shift: false });
});

test('US QWERTY symbols keep their keysym and pick the shifted code', () => {
  assert.deepEqual(charPlan('!'), { keysym: 0x21, code: 'Digit1', shift: true });
  assert.deepEqual(charPlan(':'), { keysym: 0x3a, code: 'Semicolon', shift: true });
  assert.deepEqual(charPlan('/'), { keysym: 0x2f, code: 'Slash', shift: false });
  assert.deepEqual(charPlan(' '), { keysym: 0x20, code: 'Space', shift: false });
});

test('combos accept onekvm-cu style key names', () => {
  assert.deepEqual(comboPlan('ctrl,l').map(key => key.code), ['ControlLeft', 'KeyL']);
  assert.deepEqual(comboPlan('ctrl,shift,esc').map(key => key.keysym), [0xffe3, 0xffe1, 0xff1b]);
  assert.deepEqual(comboPlan('alt+f4').map(key => key.code), ['AltLeft', 'F4']);
  assert.deepEqual(comboPlan('Enter')[0], { keysym: 0xff0d, code: 'Enter', shift: false });
  assert.deepEqual(comboPlan('win')[0], { keysym: 0xffeb, code: 'MetaLeft', shift: false });
  assert.deepEqual(comboPlan('A')[0], { keysym: 0x41, code: 'KeyA', shift: true });
});

test('text is planned per character and non ASCII is refused', () => {
  assert.equal(textPlan('ab C1').length, 5);
  assert.equal(textPlan('https://example.com').at(5).code, 'Semicolon');
  assert.equal(textPlan('https://example.com').at(6).code, 'Slash');
  assert.throws(() => textPlan('你好'), /ASCII only/);
  assert.throws(() => textPlan(''), /No text/);
  assert.throws(() => comboPlan('nope'), /Unknown key name/);
});
