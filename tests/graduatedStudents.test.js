const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Student = require('../models/Student');
const { getGraduationYear, groupGraduatedStudents } = require('../services/graduatedStudents');
const { getGraduatedStudents } = require('../controllers/graduatedStudentsController');
// Isolate list-controller tests from the enrollment cache timer and photo storage.
const enrollmentPath = require.resolve('../controllers/enrollmentController');
const photosPath = require.resolve('../services/studentPhotos');
const originalEnrollment = require.cache[enrollmentPath];
const originalPhotos = require.cache[photosPath];
require.cache[enrollmentPath] = { exports: { clearEnrollmentCache() {} } };
require.cache[photosPath] = { exports: { uploadStudentPhoto() { throw new Error('Unexpected upload'); } } };
const { getAllStudents } = require('../controllers/studentController');
if (originalEnrollment) require.cache[enrollmentPath] = originalEnrollment;
else delete require.cache[enrollmentPath];
if (originalPhotos) require.cache[photosPath] = originalPhotos;
else delete require.cache[photosPath];
const chain = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return Promise.resolve(value); }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('graduation year prefers completed academic year, then leaving date, with explicit legacy fallback', () => {
  assert.deepEqual(getGraduationYear({ graduationAcademicYear: '2025-2026', academicYear: '2026-2027' }), { year: '2026', inferred: false });
  assert.deepEqual(getGraduationYear({ dateOfLeaving: '2024-08-12', academicYear: '2025 to 2026' }), { year: '2024', inferred: false });
  assert.deepEqual(getGraduationYear({ academicYear: '2026 to 2027' }), { year: '2026', inferred: true });
  assert.deepEqual(getGraduationYear({ updatedAt: new Date(), academicYear: '' }), { year: 'Unknown', inferred: false });
});

test('groups only graduates, latest year first, names sorted and unknown years last', () => {
  const groups = groupGraduatedStudents([
    { _id: '1', status: 'graduated', graduationAcademicYear: '2025-2026', user: { name: 'Zara' } },
    { _id: '2', status: 'graduated', academicYear: '2026-2027', user: { name: 'Ama' } },
    { _id: '3', status: 'active', academicYear: '2026-2027' },
    { _id: '4', status: 'graduated', dateOfLeaving: '2023-07-01', surname: 'Osei', otherNames: 'Evans' },
    { _id: '5', status: 'graduated' }
  ]);
  assert.deepEqual(groups.map(group => group.year), ['2026', '2023', 'Unknown']);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].students.map(student => student.name), ['Ama', 'Zara']);
  assert.equal(groups[1].students[0].name, 'Osei Evans');
});

test('graduate endpoint queries only the authenticated school and graduated status', async t => {
  t.mock.method(Student, 'find', filter => {
    assert.deepEqual(filter, { school: 'school-a', status: 'graduated' });
    return chain([{ status: 'graduated', graduationAcademicYear: '2025-2026', user: { name: 'Ama' } }]);
  });
  const res = response();
  await getGraduatedStudents({ user: { school: 'school-a' }, query: { school: 'school-b' } }, res);
  assert.equal(res.body.totalStudents, 1);
  assert.equal(res.body.years[0].year, '2026');
});

test('graduate endpoint rejects missing school before querying records', async t => {
  t.mock.method(Student, 'find', () => { throw new Error('Must not query'); });
  const res = response();
  await getGraduatedStudents({ user: {} }, res);
  assert.equal(res.statusCode, 403);
});

test('Manage Students excludes graduates from rows, pagination and gender counts', async t => {
  const school = new mongoose.Types.ObjectId();
  t.mock.method(Student, 'find', filter => {
    assert.deepEqual(filter, { school, status: { $ne: 'graduated' } });
    return chain([{ status: 'active' }]);
  });
  t.mock.method(Student, 'countDocuments', async filter => {
    assert.deepEqual(filter.status, { $ne: 'graduated' }); return 1;
  });
  t.mock.method(Student, 'aggregate', async pipeline => {
    assert.equal(String(pipeline[0].$match.school), String(school));
    assert.deepEqual(pipeline[0].$match.status, { $ne: 'graduated' });
    return [{ _id: 'Female', count: 1 }];
  });
  const res = response();
  await getAllStudents({ user: { school }, query: { page: '1', excludeGraduated: 'true' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalStudents, 1);
  assert.equal(res.body.femaleCount, 1);
  assert.equal(res.body.totalPages, 1);
});

test('other student-list callers retain existing all-status behaviour', async t => {
  t.mock.method(Student, 'find', filter => {
    assert.equal(filter.status, undefined); return chain([{ status: 'graduated' }]);
  });
  const res = response();
  await getAllStudents({ user: { school: 'school-a' }, query: {} }, res);
  assert.equal(res.body[0].status, 'graduated');
});
