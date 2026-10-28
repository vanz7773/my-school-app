const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ExcelJS = require('exceljs');
const { buildStudentContactsWorkbook } = require('../services/studentContactExport');

const fixture = (number, className = 'Basic 1') => ({
  _id: `student-${number}`, admissionNumber: `00${number}`, user: { name: `Student ${number}` },
  class: { name: className }, guardianPhone: '0240000000', guardianPhone2: '+233200000000',
  academicYear: '2026-2027', status: 'active',
});

const response = () => ({
  statusCode: 200, headers: {},
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
});

function controller(find) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/studentContactController'), 'utf8'), {
    exports, Buffer, console: { error() {} },
    require(name) {
      if (name === '../models/Student') return { find };
      if (name === '../services/studentContactExport') return { buildStudentContactsWorkbook };
      if (name === '../services/studentContactImport') return require('../services/studentContactImport');
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports.downloadStudentContacts;
}

test('whole-school export ignores page, class, search and requested school filters', async () => {
  const students = Array.from({ length: 23 }, (_, index) => fixture(index + 1, index % 2 ? 'Basic 2' : 'Basic 1'));
  const download = controller(filter => {
    assert.deepEqual(Object.keys(filter), ['school']);
    assert.equal(filter.school, 'own-school');
    return { select() { return this; }, populate() { return this; }, lean: async () => students };
  });
  const res = response();
  await download({ user: { school: { _id: 'own-school' } }, query: {
    school: 'other-school', classId: 'one-class', search: 'one-name', page: '2', limit: '10',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Disposition'], /student-contacts-whole-school-\d{4}-\d{2}-\d{2}\.xlsx/);
  const workbook = await new ExcelJS.Workbook().xlsx.load(res.body);
  const sheet = workbook.getWorksheet('Student Contacts');
  assert.equal(sheet.rowCount, 24);
  const ids = sheet.getColumn(8).values.slice(2);
  assert.equal(new Set(ids).size, students.length);
  for (const student of students) assert.ok(ids.includes(student._id));
});

test('Excel round-trip preserves phone strings, leading zeros, blank phones and stable identifiers', async () => {
  const first = fixture(1, 'Basic 10');
  const second = { ...fixture(2, 'Basic 2'), guardianPhone: '', guardianPhone2: null, user: null, surname: 'Mensah', otherNames: 'Ama' };
  const formulaLike = { ...fixture(3, 'Basic 2'), user: { name: '=1+1' } };
  const original = buildStudentContactsWorkbook([first, second, formulaLike]);
  const workbook = await new ExcelJS.Workbook().xlsx.load(await original.xlsx.writeBuffer());
  const sheet = workbook.getWorksheet('Student Contacts');
  assert.equal(sheet.getCell('C2').value, 'Basic 2');
  assert.equal(sheet.getCell('C4').value, 'Basic 10');
  assert.equal(sheet.getCell('A4').value, '001');
  assert.equal(sheet.getCell('D4').value, '0240000000');
  assert.equal(sheet.getCell('E4').value, '+233200000000');
  assert.equal(sheet.getCell('B2').value, '=1+1');
  assert.equal(sheet.getCell('B2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B3').value, 'Mensah Ama');
  assert.ok(!sheet.getCell('D3').value);
  assert.ok(!sheet.getCell('E3').value);
  assert.equal(sheet.getCell('D3').numFmt, '@');
  assert.equal(sheet.getCell('E3').numFmt, '@');
  assert.equal(sheet.getCell('H3').value, 'student-2');
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.autoFilter, 'A1:H4');
});

test('missing school context is rejected before querying students', async () => {
  const download = controller(() => { throw new Error('Must not query without school'); });
  const res = response();
  await download({ user: {} }, res);
  assert.equal(res.statusCode, 403);
});

test('empty school and database failure return readable errors instead of invalid Excel files', async () => {
  const empty = controller(() => ({ select() { return this; }, populate() { return this; }, lean: async () => [] }));
  const res = response();
  await empty({ user: { school: 'school' } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /No students/);
  const failing = controller(() => { throw new Error('Database unavailable'); });
  const failedRes = response();
  await failing({ user: { school: 'school' } }, failedRes);
  assert.equal(failedRes.statusCode, 500);
  assert.match(failedRes.body.message, /Please try again/);
});
