const mongoose = require('mongoose');
const School = require('../../models/School');
const Teacher = require('../../models/Teacher');
const Assignment = require('../../models/ExamFeeCollectorAssignment');
const Audit = require('../../models/ExamFeeAudit');
const { methods } = require('../../models/examFeeFields');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = value => {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) fail(400, 'Invalid record ID.');
  return new mongoose.Types.ObjectId(value);
};
const money = (value, allowZero = false) => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 100000000000) fail(400, 'Amount must be integer pesewas within the supported range.');
  return value;
};
const text = (value, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `Text is required (maximum ${max} characters).`);
  return value.trim();
};
const requestId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) fail(400, 'Provide a unique clientRequestId (8–100 letters, digits, hyphens or underscores).');
  return value;
};
const method = value => { if (!methods.includes(value)) fail(400, 'Unsupported payment method.'); return value; };
const only = (body, fields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) fail(400, 'Unexpected request fields.');
};
const page = query => {
  const p = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(p) || p < 1 || p > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Invalid pagination (limit 1–100).');
  return { page: p, limit, skip: (p - 1) * limit };
};
const scope = user => { if (!user?.school || !['admin', 'teacher'].includes(user.role)) fail(403, 'Exam fee access denied.'); return { school: user.school }; };
const admin = user => { scope(user); if (user.role !== 'admin') fail(403, 'Administrator access required.'); };
async function teacherFor(user, session) {
  const teacher = await Teacher.findOne({ ...scope(user), user: user._id }).session(session || null);
  if (!teacher) fail(403, 'Teacher profile not found.');
  return teacher;
}
async function authorizeClass(user, campaign, classId, session) {
  if (user.role === 'admin') return null;
  const teacher = await teacherFor(user, session);
  if (!await Assignment.exists({ ...scope(user), campaign, class: classId, teacher: teacher._id, status: 'active' }).session(session || null)) fail(403, 'Not authorized to collect for this campaign and class.');
  return teacher;
}
async function audit(user, action, entityId, campaign, details, session) {
  await Audit.create([{ ...scope(user), actor: user._id, action, entityId, campaign, details }], { session });
}
// Lock order: school -> campaign/assignment -> charge/payment -> remittance.
// This serializes writes within one school, including feature disabling/revocation.
// Other schools operate independently. No external effects occur inside retries.
async function transaction(user, fn, allowDisabled = false) {
  scope(user);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const school = await School.findOneAndUpdate({ _id: user.school, ...(allowDisabled ? {} : { 'features.examFeesEnabled': true }) },
        { $inc: { examFeesRevision: 1 } }, { new: true, session });
      if (!school) fail(403, 'Exam Fees are disabled or the school is unavailable.');
      result = await fn(session, school);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return result;
  } finally { await session.endSession(); }
}
async function paginated(Model, filter, query, sort = { _id: -1 }) {
  const paging = page(query);
  const [items, total] = await Promise.all([Model.find(filter).sort(sort).skip(paging.skip).limit(paging.limit).lean(), Model.countDocuments(filter)]);
  return { items, total, page: paging.page, limit: paging.limit, totalPages: Math.ceil(total / paging.limit) };
}
module.exports = { fail, id, money, text, requestId, method, only, page, scope, admin, teacherFor, authorizeClass, audit, transaction, paginated };
