const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ExcelJS = require('exceljs');
const { buildStudentContactsWorkbook } = require('../services/studentContactExport');
const service = require('../services/studentContactImport');

const ids = ['000000000000000000000001', '000000000000000000000002', '000000000000000000000003'];
const student = (id, phone = '', second = '') => ({ _id: id, user: { name: 'Student' }, class: { name: 'Basic 2' }, guardianPhone: phone, guardianPhone2: second });
const makeBuffer = students => buildStudentContactsWorkbook(students).xlsx.writeBuffer();

test('Ghanaian and international phone numbers must be complete', () => {
  assert.equal(service.normalizePhone('233241234567'), '+233241234567');
  assert.equal(service.normalizePhone('+233 24 123 4567'), '+233241234567');
  assert.throws(() => service.normalizePhone('+23354679092'), /complete Ghanaian/);
  assert.throws(() => service.normalizePhone('0000000000'), /valid phone number/);
});

test('exported spreadsheet parses, keeps leading zeros, and treats blank cells as no change', async () => {
  const workbook = buildStudentContactsWorkbook([student(ids[0], '0241234567', ''), student(ids[1], '', '')]);
  const sheet = workbook.getWorksheet('Student Contacts');
  sheet.getCell('D3').value = 541234567; // Excel may drop the initial zero.
  const rows = await service.parseStudentContacts(await workbook.xlsx.writeBuffer());
  const preview = service.buildStudentContactsPreview(rows, [student(ids[0], '0501234567', '0201234567'), student(ids[1])]);
  assert.equal(preview.ready.length, 2);
  assert.equal(preview.issues.length, 0);
  assert.equal(preview.ready[0].updates.guardianPhone, '0241234567');
  assert.equal(preview.ready[0].updates.guardianPhone2, undefined);
  assert.equal(preview.ready[0].previous.guardianPhone2, '0201234567');
  assert.equal(preview.ready[1].updates.guardianPhone, '0541234567');
});

test('invalid numbers, duplicate IDs, other-school IDs, and formulas are reported without updating those rows', async () => {
  const workbook = buildStudentContactsWorkbook([student(ids[0]), student(ids[1]), student(ids[2])]);
  const sheet = workbook.getWorksheet('Student Contacts');
  sheet.getCell('D2').value = '054679092'; // Incomplete, not a nine-digit number missing its leading zero.
  sheet.getCell('D3').value = '0241234567';
  sheet.getCell('D4').value = { formula: '1+1', result: 2 };
  const rows = await service.parseStudentContacts(await workbook.xlsx.writeBuffer());
  const preview = service.buildStudentContactsPreview(rows, [student(ids[0]), student(ids[2])]);
  assert.equal(preview.ready.length, 0);
  assert.equal(preview.issues.length, 3);
  assert.match(preview.issues[0].message, /complete phone number/);
  assert.match(preview.issues[1].message, /not found in your school/);
  assert.match(preview.issues[2].message, /formulas/);
  const duplicateRows = [rows[0], { ...rows[0], row: 8 }];
  const duplicates = service.buildStudentContactsPreview(duplicateRows, [student(ids[0])]);
  assert.equal(duplicates.issues.length, 2);
  assert.ok(duplicates.issues.every(issue => /more than once/.test(issue.message)));
});

test('unchanged legacy values do not prevent another valid number from being added', async () => {
  const file = await makeBuffer([student(ids[0], 'old-invalid-value', '0241234567')]);
  const preview = service.buildStudentContactsPreview(await service.parseStudentContacts(file), [student(ids[0], 'old-invalid-value')]);
  assert.equal(preview.ready.length, 1);
  assert.equal(preview.ready[0].updates.guardianPhone2, '0241234567');
  assert.equal(preview.ready[0].updates.guardianPhone, undefined);
});

test('file format, sheet and headers are required', async () => {
  await assert.rejects(service.parseStudentContacts(Buffer.from('not a workbook')), /Unable to read/);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Different');
  await assert.rejects(service.parseStudentContacts(await workbook.xlsx.writeBuffer()), /Student Contacts sheet/);
  const missing = new ExcelJS.Workbook();
  missing.addWorksheet('Student Contacts').addRow(['Student ID', 'Guardian Phone']);
  await assert.rejects(service.parseStudentContacts(await missing.xlsx.writeBuffer()), /Missing column: second guardian phone/);
});

function controller(Student) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/studentContactController'), 'utf8'), {
    exports, Buffer, console: { error() {} },
    require(name) {
      if (name === '../models/Student') return Student;
      if (name === '../services/studentContactExport') return { buildStudentContactsWorkbook };
      if (name === '../services/studentContactImport') return service;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports;
}
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('preview queries only the signed-in school and returns only its students', async () => {
  const handler = controller({ find(query) {
    assert.equal(query.school, 'school-a');
    return { select() { return this; }, populate() { return this; }, lean: async () => [student(ids[0])] };
  } }).previewStudentContacts;
  const res = response();
  await handler({ user: { school: 'school-a' }, file: { buffer: await makeBuffer([student(ids[0], '0241234567'), student(ids[1], '0541234567')]) } }, res);
  assert.equal(res.body.ready.length, 1);
  assert.equal(res.body.issues.length, 1);
  assert.match(res.body.issues[0].message, /not found in your school/);
});

test('save limits updates to reviewed phone fields in the school and rejects changed contacts', async () => {
  const calls = [];
  const handler = controller({ findOneAndUpdate(query, update, options) {
    calls.push({ query, update, options });
    return { select() { return this; }, lean: async () => calls.length === 1 ? { _id: ids[0] } : null };
  } }).applyStudentContacts;
  const rows = [0, 1].map(i => ({ studentId: ids[i], row: i + 2, previous: { guardianPhone: '', guardianPhone2: '0201234567' }, updates: { guardianPhone: '0241234567' } }));
  const res = response();
  await handler({ user: { school: 'school-a' }, body: { rows } }, res);
  assert.equal(res.body.saved, 1);
  assert.equal(res.body.issues.length, 1);
  assert.match(res.body.issues[0].message, /changed since preview/);
  assert.equal(calls[0].query.school, 'school-a');
  assert.deepEqual(Array.from(calls[0].query.guardianPhone.$in), ['', null]);
  assert.equal(calls[0].query.guardianPhone2, '0201234567');
  assert.equal(calls[0].update.$set.guardianPhone, '0241234567');
  assert.equal(calls[0].options.runValidators, true);
});

test('save validates every row before any database write', async () => {
  let writes = 0;
  const handler = controller({ findOneAndUpdate() { writes++; } }).applyStudentContacts;
  const valid = { studentId: ids[0], previous: { guardianPhone: '', guardianPhone2: '' }, updates: { guardianPhone: '0241234567' } };
  for (const invalid of [
    { ...valid, studentId: ids[1], updates: { guardianPhone: '054679092' } },
    { ...valid, updates: { school: 'other-school' } },
    { ...valid, updates: { guardianPhone: '' } },
    valid,
  ]) {
    const res = response();
    await handler({ user: { school: 'school-a' }, body: { rows: [valid, invalid] } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(writes, 0);
  }
});
