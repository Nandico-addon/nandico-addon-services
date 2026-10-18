'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClientRegistry, getGroupConfig } = require('../src/clients');

test('client configuration mutations cannot leak into another request or client', () => {
  const first = getGroupConfig(48991);
  const second = { ...structuredClone(first), groupId: 900002, clientName: 'TEST SECOND CLIENT' };
  const registry = createClientRegistry([first, second]);
  first.templates.SIGNOFF.PATIENT.fields[0] = 'otpCode';
  second.credentialRefs.authKey = 'WRONG_KEY';
  const request = registry.getGroupConfig(48991);
  request.templates.SIGNOFF.PATIENT.name = 'changed_template';
  request.credentialRefs.authKey = 'CHANGED_KEY';
  request.events.length = 0;
  assert.deepEqual(registry.getGroupConfig(48991), getGroupConfig(48991));
  assert.equal(registry.getGroupConfig(900002).templates.SIGNOFF.PATIENT.fields[0], 'patientName');
  assert.equal(registry.getGroupConfig(900002).credentialRefs.authKey, 'GROUP_48991_ICLOUDSMS_AUTH_KEY');
  assert.equal(registry.getGroupConfig(99999), null);
  assert.equal(registry.getGroupConfig('48991'), null);
});

test('duplicate client group IDs fail immediately instead of silently replacing a client', () => {
  const group = getGroupConfig(48991);
  assert.throws(() => createClientRegistry([group, group]), /unique positive PACS group ID/);
  for (const groupId of [0, -1, '48991', NaN]) {
    assert.throws(() => createClientRegistry([{ ...group, groupId }]), /unique positive PACS group ID/);
  }
});
