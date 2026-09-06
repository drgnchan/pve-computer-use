import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitVncTicket, describeTicketShape } from '../src/pve-api.js';

test('prefers the explicit password field', () => {
  assert.deepEqual(
    splitVncTicket('abcd1234:PVEVNC:user@pve:/vms/105:ABC', 'explicit!'),
    { password: 'explicit!', vncticket: 'abcd1234:PVEVNC:user@pve:/vms/105:ABC' }
  );
});

test('falls back to the ticket prefix on older PVE versions', () => {
  // PVE generates the password from '!' (33) to '`' (96): no lowercase letters.
  const ticket = 'AB3!XY9`:PVEVNC:pve-cu@pve:/vms/105:DEADBEEF';
  assert.deepEqual(splitVncTicket(ticket, undefined), { password: 'AB3!XY9`', vncticket: ticket });
  // The prefix may itself contain colons; exactly 8 characters are consumed.
  const tricky = ':::A:B:C:PVEVNC:pve-cu@pve:/vms/105:1';
  assert.deepEqual(splitVncTicket(tricky, null), { password: ':::A:B:C', vncticket: tricky });
});

test('PVE 7 style bare tickets use the ticket itself as the VNC password', () => {
  const ticket = 'PVEVNC:pve-cu@pve:/vms/105:5900:DEADBEEF';
  assert.deepEqual(splitVncTicket(ticket, undefined), { password: ticket, vncticket: ticket });
});

test('unrecognisable tickets produce non-secret diagnostics', () => {
  const shape = describeTicketShape('xyz:PVEVNC:a');
  assert.match(shape, /length=12/);
  assert.match(shape, /pvevncAtIndex=4/);
  assert.match(shape, /prefixLength=3/);
  assert.match(shape, /prefixInPveRange=false/);
  assert.throws(() => splitVncTicket('xyz:PVEVNC:a', undefined), /length=12, pvevncAtIndex=4/);
  assert.equal(describeTicketShape('PVEVNC:a').includes('pvevncAtIndex=0'), true);
});

test('rejects responses with neither form', () => {
  assert.throws(() => splitVncTicket('short:PVEVNC:x', undefined), /no RFB console password|unrecognisable/);
  assert.throws(() => splitVncTicket('', undefined), /unrecognisable/);
  assert.throws(() => splitVncTicket('aaaaaaaa:PVETUNNEL:x', undefined), /unrecognisable/);
});
