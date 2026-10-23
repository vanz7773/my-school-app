const mongoose = require('mongoose');
const Student = require('../models/Student');
const SbaRecord = require('../models/SbaRecord');
const Term = require('../models/term');
const idString = value => String(value?._id || value || '');

async function getTermStudents({ schoolId, classId, termId, records, includeParents = false }) {
  const term = await Term.findOne({ _id: termId, school: schoolId }).select('endDate').lean();
  if (!term) throw Object.assign(new Error('Term not found'), { statusCode: 404 });
  const sheets = records || await SbaRecord.find({ school: schoolId, class: classId, term: termId }).select('records').lean();
  const ids = [...new Set(sheets.flatMap(sheet => (sheet.records || []).flatMap(mark => [mark.student, mark.studentUser, mark.studentDocId, mark.studentUserId]).map(idString)).filter(id => mongoose.isValidObjectId(id)))];
  const termEnd = new Date(term.endDate);
  termEnd.setHours(23, 59, 59, 999);
  const historical = term.endDate && termEnd.getTime() < Date.now();
  // Historical rosters come from saved marks, not the pupils currently in that classroom.
  if (historical && !ids.length) return [];
  const roster = [{ _id: { $in: ids } }, { user: { $in: ids } }];
  if (!historical) roster.push({ class: classId });
  let query = Student.find({ school: schoolId, $or: roster }).populate('user', 'name profilePicture');
  if (includeParents) query = query.populate('parent parentIds');
  return query.lean();
}

async function resolveReportClass(req) {
  const { schoolId, classId, termId, studentId } = req.query;
  if (req.user.role !== 'superadmin' && idString(req.user.school) !== String(schoolId)) {
    throw Object.assign(new Error('School access denied'), { statusCode: 403 });
  }
  if (!['student', 'parent'].includes(req.user.role)) return classId;
  let query = { school: schoolId };
  if (req.user.role === 'student') query.user = req.user._id;
  else {
    query.$and = [{ $or: [{ parent: req.user._id }, { parentIds: req.user._id }] }];
    if (studentId && mongoose.isValidObjectId(studentId)) query.$and.push({ $or: [{ _id: studentId }, { user: studentId }] });
    else query.class = classId;
  }
  const students = await Student.find(query).lean();
  if (students.length !== 1) throw Object.assign(new Error('Select a linked student to view this report'), { statusCode: 403 });
  const student = students[0];
  const historical = await SbaRecord.findOne({ school: schoolId, term: termId, $or: [
    { 'records.student': student._id }, { 'records.student': student.user }, { 'records.studentUser': student.user },
  ] }).sort({ updatedAt: -1 }).select('class').lean();
  return idString(historical?.class || student.class);
}

async function freshReportUrl(student, termId, bucketOverride) {
  const termKey = String(termId);
  const saved = student.reportCards?.get?.(termKey) || student.reportCards?.[termKey];
  const metadata = student.reportCardMetadata?.get?.(termKey) || student.reportCardMetadata?.[termKey];
  if (!saved && !metadata?.storagePath) return null;
  const bucket = bucketOverride || require('firebase-admin').storage().bucket();
  let storagePath = metadata?.storagePath;
  if (!storagePath && saved) {
    try {
      const url = new URL(saved);
      if (url.hostname === 'storage.googleapis.com') {
        const [bucketName, ...parts] = url.pathname.slice(1).split('/');
        if (bucketName === bucket.name) storagePath = decodeURIComponent(parts.join('/'));
      } else if (url.hostname === 'firebasestorage.googleapis.com') {
        const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
        if (match && decodeURIComponent(match[1]) === bucket.name) storagePath = decodeURIComponent(match[2]);
      }
    } catch { /* Preserve legacy links that do not use a recognized storage URL. */ }
  }
  const parts = String(storagePath || '').split('/');
  if (parts.length !== 5 || parts[0] !== 'reportcards' || parts[1] !== idString(student.school) ||
      parts[3] !== termKey || parts[4] !== `${idString(student._id)}.pdf`) return saved || null;
  const [url] = await bucket.file(storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
  return url;
}
module.exports = { getTermStudents, resolveReportClass, freshReportUrl };
