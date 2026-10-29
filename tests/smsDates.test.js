const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatSmsDate } = require('../utils/smsDates');

test('SMS dates show the full month and the recorded payment date', () => {
  assert.equal(formatSmsDate(new Date('2026-10-29T12:00:00Z')), '29 October 2026');
  assert.equal(formatSmsDate('2025-07-04T12:00:00Z'), '4 July 2025');
});

test('SMS dates use Ghana time across midnight and year boundaries', () => {
  assert.equal(formatSmsDate('2026-01-01T00:30:00+02:00'), '31 December 2025');
});

test('missing or invalid dates cannot silently appear as a misleading date', () => {
  for (const value of [undefined, null, '', 'invalid']) {
    assert.throws(() => formatSmsDate(value), /valid date/);
  }
});
