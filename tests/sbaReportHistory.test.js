const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Student = require('../models/Student');
const SbaRecord = require('../models/SbaRecord');
const Term = require('../models/term');
const Class = require('../models/Class');
const { getTermStudents, resolveReportClass, freshReportUrl } = require('../services/sbaReportHistory');
const reports = require('../controllers/sbaV2ReportController');
const id = () => new mongoose.Types.ObjectId();
const chain = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => value });

function mocks(t) {
  const saved = [Student.find, SbaRecord.find, SbaRecord.findOne, Term.findOne, Class.findOne];
  t.after(() => { [Student.find, SbaRecord.find, SbaRecord.findOne, Term.findOne, Class.findOne] = saved; });
}

test('old term roster retains promoted students and never substitutes the new class roster', async t => {
  mocks(t);
  const schoolId = id(), classId = id(), termId = id(), promotedId = id(), userId = id();
  Term.findOne = query => { assert.equal(query.school, schoolId); return chain({ endDate: '2020-06-01' }); };
  Student.find = query => {
    assert.equal(query.school, schoolId);
    assert.ok(!query.$or.some(condition => condition.class));
    assert.ok(query.$or[0]._id.$in.includes(String(promotedId)));
    return chain([{ _id: promotedId, class: id(), user: { _id: userId, name: 'Promoted Student' } }]);
  };
  const result = await getTermStudents({ schoolId, classId, termId, records: [{ records: [{ student: promotedId, studentUser: userId }] }] });
  assert.equal(result[0].user.name, 'Promoted Student');
});

test('current term roster includes new pupils even before their first marks are saved', async t => {
  mocks(t);
  const classId = id();
  Term.findOne = () => chain({ endDate: '2099-06-01' });
  Student.find = query => { assert.ok(query.$or.some(condition => condition.class === classId)); return chain([{ _id: id() }]); };
  assert.equal((await getTermStudents({ schoolId: id(), classId, termId: id(), records: [] })).length, 1);
});

test('old terms without saved marks do not return the class current pupils as historical reports', async t => {
  mocks(t);
  Term.findOne = () => chain({ endDate: '2020-06-01' });
  Student.find = () => { throw new Error('Must not substitute the current roster'); };
  assert.deepEqual(await getTermStudents({ schoolId: id(), classId: id(), termId: id(), records: [] }), []);
});

test('student historical analysis resolves their old class independently of the supplied current class', async t => {
  mocks(t);
  const school = id(), studentId = id(), userId = id(), oldClass = id(), newClass = id();
  Student.find = query => { assert.equal(query.user, userId); assert.equal(query.school, school); return chain([{ _id: studentId, user: userId, class: newClass }]); };
  SbaRecord.findOne = query => { assert.equal(query.class, undefined); assert.equal(query.school, school); return chain({ class: oldClass }); };
  const resolved = await resolveReportClass({ user: { role: 'student', school, _id: userId }, query: { schoolId: school, classId: newClass, termId: id() } });
  assert.equal(resolved, String(oldClass));
});

test('parents are restricted to linked children and cross-school queries are rejected', async t => {
  mocks(t);
  const school = id(), parentId = id(), childId = id();
  Student.find = query => {
    assert.equal(query.$and[0].$or[0].parent, parentId);
    assert.equal(query.$and[1].$or[0]._id, childId);
    return chain([]);
  };
  await assert.rejects(resolveReportClass({ user: { role: 'parent', school, _id: parentId }, query: { schoolId: school, studentId: childId, classId: id(), termId: id() } }), /linked student/);
  await assert.rejects(resolveReportClass({ user: { role: 'admin', school }, query: { schoolId: id(), classId: id(), termId: id() } }), /School access denied/);
});

test('expired report links are renewed from the original class path without moving the report', async () => {
  const school = id(), studentId = id(), oldClass = id(), termId = id();
  const storagePath = `reportcards/${school}/${oldClass}/${termId}/${studentId}.pdf`;
  const student = { _id: studentId, school, class: id(), reportCards: { [termId]: `https://storage.googleapis.com/school-reports/${storagePath}?Expires=1&Signature=expired` } };
  let signedPath;
  const bucket = { name: 'school-reports', file(path) { signedPath = path; return { getSignedUrl: async options => { assert.ok(options.expires > Date.now()); return ['https://fresh-url.test/report.pdf']; } }; } };
  assert.equal(await freshReportUrl(student, termId, bucket), 'https://fresh-url.test/report.pdf');
  assert.equal(signedPath, storagePath);
});

test('stored archival paths cannot sign another school or student report', async () => {
  const termId = id(), saved = 'https://external.test/legacy.pdf';
  const student = { _id: id(), school: id(), reportCards: { [termId]: saved }, reportCardMetadata: { [termId]: { storagePath: `reportcards/${id()}/${id()}/${termId}/${id()}.pdf` } } };
  const bucket = { name: 'school-reports', file() { throw new Error('Must not sign unrelated report'); } };
  assert.equal(await freshReportUrl(student, termId, bucket), saved);
});

test('V2 report controller generates old-term marks for a student now in a new class', async t => {
  mocks(t);
  const schoolId = id(), classId = id(), termId = id(), studentId = id(), userId = id(), subjectId = id();
  Class.findOne = () => chain({ name: 'BS 3' });
  Term.findOne = () => chain({ endDate: '2020-06-01' });
  SbaRecord.find = () => chain([{ subject: { _id: subjectId, name: 'Maths' }, records: [{ student: studentId, studentUser: userId, classWork: 10, classTest1: 20, classTest2: 20, projectWork: 10, exams: 80 }] }]);
  Student.find = () => chain([{ _id: studentId, class: id(), user: { _id: userId, name: 'Ama' } }]);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await reports.getClassReportCards({ user: { role: 'admin', school: schoolId }, query: { schoolId, classId, termId } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.className, 'BS 3');
  assert.equal(res.body.data[0].studentInfo.name, 'Ama');
  assert.equal(res.body.data[0].subjects[0].total, 90);
});

test('Student schema preserves per-term storage paths and original class metadata', () => {
  const termId = String(id()), student = new Student({ reportCardMetadata: { [termId]: { source: 'sba-v2', storagePath: 'reportcards/original/path.pdf', className: 'BS 3' } } });
  assert.equal(student.reportCardMetadata.get(termId).className, 'BS 3');
});
