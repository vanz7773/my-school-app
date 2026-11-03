const mongoose = require('mongoose');
const Campaign = require('../../models/ExamFeeCampaign');
const Charge = require('../../models/ExamFeeCharge');
const Payment = require('../../models/ExamFeePayment');
const Remittance = require('../../models/ExamFeeRemittance');
const Audit = require('../../models/ExamFeeAudit');
const c = require('./core');
const { examinationTypes } = require('../../models/examFeeFields');
const sumIf = (condition, value) => ({ $sum: { $cond: [condition, value, 0] } });
const recorded = { $eq: ['$status', 'recorded'] };
const paymentTotals = {
  collectedPesewas: sumIf(recorded, '$amountPesewas'),
  cashPesewas: sumIf({ $and: [recorded, { $eq: ['$method', 'cash'] }] }, '$amountPesewas'),
  teacherCollectedPesewas: sumIf({ $and: [recorded, { $ne: [{ $ifNull: ['$teacher', null] }, null] }] }, '$amountPesewas'),
  reversedPesewas: sumIf({ $eq: ['$status', 'reversed'] }, '$amountPesewas'),
  reversedTransactions: sumIf({ $eq: ['$status', 'reversed'] }, 1),
  paymentCount: sumIf(recorded, 1)
};
const handoverTotals = {
  confirmedPesewas: sumIf({ $eq: ['$status', 'confirmed'] }, '$amountPesewas'),
  pendingPesewas: sumIf({ $eq: ['$status', 'submitted'] }, '$amountPesewas')
};
const defaults = { expectedPesewas: 0, collectedPesewas: 0, outstandingPesewas: 0, teacherCollectedPesewas: 0, cashPesewas: 0,
  paidStudents: 0, partialStudents: 0, unpaidStudents: 0, chargedStudents: 0, reversedPesewas: 0, reversedTransactions: 0, paymentCount: 0, confirmedPesewas: 0, pendingPesewas: 0 };
async function snapshot(fn) {
  const session = await mongoose.startSession();
  try { let value; await session.withTransaction(async () => { value = await fn(session); }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' }); return value; }
  finally { await session.endSession(); }
}
exports.adminReport = async (user, query) => {
  c.admin(user); const paging = c.page(query);
  const campaignFilter = { school: new mongoose.Types.ObjectId(user.school) };
  if (query.campaignId) campaignFilter._id = c.id(query.campaignId);
  if (query.academicYear) campaignFilter.academicYear = c.text(query.academicYear, 20);
  if (query.termId) campaignFilter.term = c.id(query.termId);
  if (query.examinationType) { if (!examinationTypes.includes(query.examinationType)) c.fail(400, 'Invalid examination type.'); campaignFilter.examinationType = query.examinationType; }
  const groupBy = query.groupBy || 'class';
  if (!['class', 'teacher', 'campaign', 'examinationType', 'academicYear', 'term', 'method'].includes(groupBy)) c.fail(400, 'Invalid report grouping.');
  return snapshot(async session => {
    const campaigns = await Campaign.find(campaignFilter).select('_id').session(session).lean();
    const match = { school: campaignFilter.school, campaign: { $in: campaigns.map(item => item._id) } };
    if (query.classId) match.class = c.id(query.classId);
    const chargeRows = await Charge.aggregate([{ $match: match }, { $group: { _id: null,
      expectedPesewas: { $sum: '$amountDuePesewas' }, outstandingPesewas: { $sum: { $subtract: ['$amountDuePesewas', '$netPaidPesewas'] } },
      chargedStudents: { $sum: 1 }, paidStudents: sumIf({ $eq: ['$netPaidPesewas', '$amountDuePesewas'] }, 1),
      partialStudents: sumIf({ $and: [{ $gt: ['$netPaidPesewas', 0] }, { $lt: ['$netPaidPesewas', '$amountDuePesewas'] }] }, 1),
      unpaidStudents: sumIf({ $and: [{ $eq: ['$netPaidPesewas', 0] }, { $gt: ['$amountDuePesewas', 0] }] }, 1)
    } }]).session(session);
    const totals = await Payment.aggregate([{ $match: match }, { $group: { _id: null, ...paymentTotals } }]).session(session);
    // Class reports use payment allocation totals, preserving a handover's original class.
    let handovers;
    if (match.class) {
      handovers = await Payment.aggregate([{ $match: match }, { $group: { _id: null, confirmedPesewas: { $sum: '$remittedPesewas' }, pendingPesewas: { $sum: '$reservedPesewas' } } }]).session(session);
    } else handovers = await Remittance.aggregate([{ $match: match }, { $group: { _id: null, ...handoverTotals } }]).session(session);
    const summary = { ...defaults, ...chargeRows[0], ...totals[0], ...handovers[0] }; delete summary._id;
    const teacherBalances = await Payment.aggregate([{ $match: { ...match, teacher: { $ne: null } } },
      { $group: { _id: '$teacher', collected: sumIf(recorded, '$amountPesewas'), confirmed: { $sum: '$remittedPesewas' } } }
    ]).session(session);
    // One teacher's over-remittance must not conceal another teacher's money still owed.
    summary.outstandingTeacherRemittancesPesewas = teacherBalances.reduce((sum, item) => sum + Math.max(0, item.collected - item.confirmed), 0);
    summary.overRemittedPesewas = teacherBalances.reduce((sum, item) => sum + Math.max(0, item.confirmed - item.collected), 0);
    if (groupBy === 'class') {
      const [classes] = await Charge.aggregate([{ $match: match }, { $group: {
        _id: '$class', className: { $first: '$className' }, expectedPesewas: { $sum: '$amountDuePesewas' },
        collectedPesewas: { $sum: '$netPaidPesewas' }, outstandingPesewas: { $sum: { $subtract: ['$amountDuePesewas', '$netPaidPesewas'] } },
        chargedStudents: { $sum: 1 }
      } }, { $sort: { className: 1, _id: 1 } }, { $facet: { items: [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: 'count' }] } }]).session(session);
      const total = classes.total[0]?.count || 0;
      return { summary, countUnit: 'student_campaign_charge', groupBy, items: classes.items, total, page: paging.page, limit: paging.limit, totalPages: Math.ceil(total / paging.limit) };
    }
    const campaignGroup = ['examinationType', 'academicYear', 'term'].includes(groupBy);
    const pipeline = [{ $match: match }];
    if (campaignGroup) pipeline.push({ $lookup: { from: Campaign.collection.name, let: { campaign: '$campaign', school: '$school' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$_id', '$$campaign'] }, { $eq: ['$school', '$$school'] }] } } }
    ], as: 'campaignInfo' } }, { $unwind: '$campaignInfo' });
    pipeline.push({ $group: { _id: campaignGroup ? `$campaignInfo.${groupBy}` : `$${groupBy}`,
      ...paymentTotals, collectorName: { $first: '$collectorName' } } }, { $sort: { _id: 1 } },
    { $facet: { items: [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: 'count' }] } });
    const [groups] = await Payment.aggregate(pipeline).session(session);
    const total = groups.total[0]?.count || 0;
    return { summary, countUnit: 'student_campaign_charge', groupBy, items: groups.items.map(({ collectorName, ...item }) => groupBy === 'teacher' ? { ...item, collectorName } : item), total, page: paging.page, limit: paging.limit, totalPages: Math.ceil(total / paging.limit) };
  });
};
exports.collectorSummary = async (user, query) => {
  const teacher = user.role === 'teacher' ? (await c.teacherFor(user))._id : query.teacherId ? c.id(query.teacherId) : null;
  const match = { school: new mongoose.Types.ObjectId(user.school) };
  if (teacher) match.teacher = teacher;
  else match.teacher = { $ne: null };
  if (query.campaignId) match.campaign = c.id(query.campaignId);
  const paging = c.page(query);
  return snapshot(async session => {
    const pipeline = [{ $match: match }, { $group: { _id: '$teacher', collectorName: { $first: '$collectorName' }, ...paymentTotals,
      confirmedPesewas: { $sum: '$remittedPesewas' }, pendingPesewas: { $sum: '$reservedPesewas' } } },
    { $sort: { _id: 1 } }, { $facet: { items: [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: 'count' }] } }];
    const [result] = await Payment.aggregate(pipeline).session(session);
    return { items: result.items.map(item => ({ ...item,
      outstandingPesewas: Math.max(0, item.collectedPesewas - item.confirmedPesewas),
      availableToSubmitPesewas: Math.max(0, item.collectedPesewas - item.confirmedPesewas - item.pendingPesewas),
      overRemittedPesewas: Math.max(0, item.confirmedPesewas - item.collectedPesewas)
    })), total: result.total[0]?.count || 0, page: paging.page, limit: paging.limit };
  });
};
exports.auditTrail = async (user, query) => {
  c.admin(user); const filter = c.scope(user);
  if (query.campaignId) filter.campaign = c.id(query.campaignId);
  return c.paginated(Audit, filter, query);
};
