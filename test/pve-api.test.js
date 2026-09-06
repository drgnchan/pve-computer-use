import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitVncTicket } from '../src/pve-api.js';

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

test('rejects responses with neither form', () => {
  assert.throws(() => splitVncTicket('PVEVNC:pve-cu@pve:/vms/105:1', undefined), /no RFB console password/);
  assert.throws(() => splitVncTicket('short:PVEVNC:x', undefined), /no RFB console password/);
  assert.throws(() => splitVncTicket('', undefined), /no RFB console password/);
  assert.throws(() => splitVncTicket('aaaaaaaa:PVETUNNEL:x', undefined), /no RFB console password/);
});
