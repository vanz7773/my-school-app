const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../controllers/studentAttendanceController'), 'utf8');
const handlerSource = source.slice(source.indexOf('const getClassTermAttendance ='), source.indexOf('// -------------------- Exports'));

for (const historical of [true, false]) {
  test(`${historical ? 'past' : 'current'} term attendance retains promoted pupils and stable identifiers`, async () => {
    let rosterQuery;
    const student = { _id: 'promoted', user: { _id: 'user1', name: 'Same Name' }, class: 'new-class' };
    const week = { student: 'promoted', weekNumber: 1, totalPresent: 4, days: { M: 'present' } };
    const handler = vm.runInNewContext(`${handlerSource}\ngetClassTermAttendance`, {
      StudentAttendance: { find(query) {
        assert.equal(query.class, 'old-class');
        assert.equal(query.termId, 'old-term');
        assert.equal(query.school, 'school');
        return { lean: async () => [week] };
      } },
      Student: { find(query) {
        rosterQuery = query;
        return { populate() { return this; }, lean: async () => [student] };
      } },
      Term: { findOne: () => ({ lean: async () => ({ endDate: historical ? '2020-01-01' : '2099-01-01' }) }) },
      console,
    });
    let result;
    await handler({ query: { classId: 'old-class', termId: 'old-term' }, user: { school: 'school' } }, {
      json(value) { result = value; }, status(code) { throw new Error(`Unexpected status ${code}`); },
    });
    assert.equal(rosterQuery.school, 'school');
    const ids = historical ? rosterQuery._id.$in : rosterQuery.$or[1]._id.$in;
    assert.equal(ids[0], 'promoted');
    if (historical) assert.equal(rosterQuery.class, undefined);
    else assert.equal(rosterQuery.$or[0].class, 'old-class');
    assert.equal(result[0].studentDocId, 'promoted');
    assert.equal(result[0].user._id, 'user1');
    assert.equal(result[0].attendance[0].totalPresent, 4);
  });
}
