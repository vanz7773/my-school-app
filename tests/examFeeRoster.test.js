const { test } = require('node:test');
const assert = require('node:assert/strict');
const { academicYearPattern } = require('../services/examFees/roster');
test('equivalent academic year formats match without admitting another year', () => {
 const pattern = academicYearPattern('2026-2027');
 for (const year of ['2026-2027', '2026 to 2027', '2026/2027', ' 2026 / 2027 ', '2026 - 2027', '2026 TO 2027']) assert.ok(pattern.test(year), year);
 for (const year of ['2025-2026', '2027-2028', '2026-20270', '', '2026-2027 extra']) assert.equal(pattern.test(year), false, year);
 assert.throws(() => academicYearPattern('2026.*'), error => error.status === 400);
});
