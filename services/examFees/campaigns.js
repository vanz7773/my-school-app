const School = require('../../models/School');
const Term = require('../../models/term');
const Class = require('../../models/Class');
const Student = require('../../models/Student');
const Teacher = require('../../models/Teacher');
const User = require('../../models/User');
const Campaign = require('../../models/ExamFeeCampaign');
const Charge = require('../../models/ExamFeeCharge');
const Assignment = require('../../models/ExamFeeCollectorAssignment');
const Payment = require('../../models/ExamFeePayment');
const Remittance = require('../../models/ExamFeeRemittance');
const c = require('./core');
const { examinationTypes } = require('../../models/examFeeFields');

exports.getSettings = async user => {
  c.admin(user);
  const school = await School.findOne({ _id: user.school }).select('features.examFeesEnabled');
  if (!school) c.fail(404, 'School not found.');
  return { examFeesEnabled: school.features?.examFeesEnabled === true };
};
exports.updateSettings = async (user, body) => {
  c.admin(user); c.only(body, ['examFeesEnabled']);
  if (typeof body.examFeesEnabled !== 'boolean') c.fail(400, 'examFeesEnabled must be boolean.');
  return c.transaction(user, async (session, school) => {
    const previous = school.features?.examFeesEnabled === true;
    await School.updateOne({ _id: user.school }, { $set: { 'features.examFeesEnabled': body.examFeesEnabled } }, { session });
    await c.audit(user, 'settings.updated', school._id, null, { previous, enabled: body.examFeesEnabled }, session);
    return body;
  }, true);
};
async function definition(user, body, session) {
  c.only(body, ['name', 'examinationType', 'academicYear', 'termId', 'classFees']);
  if (!examinationTypes.includes(body.examinationType)) c.fail(400, 'Invalid examinationType.');
  const term = await Term.findOne({ ...c.scope(user), _id: c.id(body.termId) }).session(session);
  if (!term) c.fail(404, 'Term not found.');
  if (body.academicYear !== term.academicYear) c.fail(400, 'Academic year must match the selected term.');
  if (!Array.isArray(body.classFees) || !body.classFees.length || body.classFees.length > 100) c.fail(400, 'Select 1–100 classes.');
  const seen = new Set(), classFees = [];
  for (const fee of body.classFees) {
    c.only(fee, ['classId', 'amountPesewas']);
    const classId = c.id(fee.classId);
    if (seen.has(String(classId))) c.fail(400, 'Duplicate class.');
    seen.add(String(classId));
    const cls = await Class.findOne({ ...c.scope(user), _id: classId }).session(session);
    if (!cls) c.fail(404, 'Class not found.');
    classFees.push({ class: cls._id, className: cls.displayName || cls.name, amountPesewas: c.money(fee.amountPesewas) });
  }
  return { name: c.text(body.name, 120), examinationType: body.examinationType, academicYear: term.academicYear, term: term._id, termName: term.term, classFees };
}
exports.saveDraft = async (user, body, campaignId) => {
  c.admin(user); if (campaignId) c.id(campaignId);
  return c.transaction(user, async session => {
    let campaign = campaignId ? await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session) : null;
    if (campaignId && !campaign) c.fail(404, 'Campaign not found.');
    if (campaign && campaign.status !== 'draft') c.fail(409, 'Only draft campaigns can be edited. Adjust charges explicitly after activation.');
    const fields = await definition(user, body, session);
    if (campaign) { Object.assign(campaign, fields); await campaign.save({ session }); }
    else [campaign] = await Campaign.create([{ ...c.scope(user), ...fields, createdBy: user._id }], { session });
    await c.audit(user, campaignId ? 'campaign.edited' : 'campaign.created', campaign._id, campaign._id, fields, session);
    return campaign;
  });
};
exports.activate = async (user, campaignId) => {
  c.admin(user); c.id(campaignId);
  return c.transaction(user, async session => {
    const campaign = await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session);
    if (!campaign) c.fail(404, 'Campaign not found.');
    if (campaign.status === 'closed') c.fail(409, 'Closed campaigns cannot be activated.');
    if (campaign.status === 'active') return { campaign, chargesGenerated: 0, alreadyActive: true };
    let count = 0;
    // Stream the roster and insert bounded batches; activation remains one atomic transaction.
    for (const fee of campaign.classFees) {
      const cursor = Student.find({ ...c.scope(user), class: fee.class, status: { $nin: ['graduated', 'withdrawn'] },
        academicYear: { $in: [campaign.academicYear, campaign.academicYear.replace('-', ' to ')] }
      }).populate({ path: 'user', select: 'name', match: { school: user.school } }).session(session).cursor();
      let batch = [];
      for await (const student of cursor) {
        batch.push({ ...c.scope(user), campaign: campaign._id, student: student._id, class: fee.class,
          studentName: student.user?.name || [student.surname, student.otherNames].filter(Boolean).join(' ') || 'Student',
          admissionNumber: student.admissionNumber || '', className: fee.className,
          originalAmountPesewas: fee.amountPesewas, amountDuePesewas: fee.amountPesewas, netPaidPesewas: 0 });
        count++;
        if (batch.length === 250) { await Charge.insertMany(batch, { session }); batch = []; }
      }
      if (batch.length) await Charge.insertMany(batch, { session });
    }
    if (!count) c.fail(409, 'No eligible enrolled students match the campaign classes and academic year.');
    campaign.status = 'active'; campaign.activatedBy = user._id; campaign.activatedAt = new Date();
    await campaign.save({ session });
    await c.audit(user, 'campaign.activated', campaign._id, campaign._id, { chargesGenerated: count }, session);
    return { campaign, chargesGenerated: count };
  });
};
exports.close = async (user, campaignId) => {
  c.admin(user); c.id(campaignId);
  return c.transaction(user, async session => {
    const campaign = await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session);
    if (!campaign) c.fail(404, 'Campaign not found.');
    if (campaign.status === 'closed') return campaign;
    if (campaign.status !== 'active') c.fail(409, 'Only active campaigns may be closed.');
    campaign.status = 'closed'; campaign.closedBy = user._id; campaign.closedAt = new Date(); await campaign.save({ session });
    await c.audit(user, 'campaign.closed', campaign._id, campaign._id, {}, session); return campaign;
  });
};
exports.list = async (user, query) => {
  const filter = c.scope(user);
  if (query.academicYear) filter.academicYear = c.text(query.academicYear, 20);
  if (query.termId) filter.term = c.id(query.termId);
  if (query.examinationType) { if (!examinationTypes.includes(query.examinationType)) c.fail(400, 'Invalid examination type.'); filter.examinationType = query.examinationType; }
  if (query.status) { if (!['draft', 'active', 'closed'].includes(query.status)) c.fail(400, 'Invalid status.'); filter.status = query.status; }
  let assignments;
  if (user.role === 'teacher') {
    const teacher = await c.teacherFor(user);
    assignments = await Assignment.find({ ...c.scope(user), teacher: teacher._id, status: 'active' }).lean();
    filter._id = { $in: assignments.map(a => a.campaign) };
    if (!query.status) filter.status = { $ne: 'draft' };
  }
  const result = await c.paginated(Campaign, filter, query);
  if (assignments) result.items = result.items.map(item => ({ ...item, classFees: item.classFees.filter(fee => assignments.some(a => String(a.campaign) === String(item._id) && String(a.class) === String(fee.class))) }));
  return result;
};
exports.assign = async (user, campaignId, body) => {
  c.admin(user); c.id(campaignId); c.only(body, ['teacherId', 'classId']); c.id(body.teacherId); c.id(body.classId);
  return c.transaction(user, async session => {
    const campaign = await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session);
    if (!campaign) c.fail(404, 'Campaign not found.');
    if (campaign.status === 'closed') c.fail(409, 'Campaign is closed.');
    if (!campaign.classFees.some(f => String(f.class) === String(c.id(body.classId)))) c.fail(400, 'Class is not in this campaign.');
    const teacher = await Teacher.findOne({ ...c.scope(user), _id: body.teacherId }).session(session);
    if (!teacher || !await User.exists({ ...c.scope(user), _id: teacher.user, role: 'teacher', isActive: { $ne: false } }).session(session)) c.fail(404, 'Active teacher not found.');
    const assignment = await Assignment.findOneAndUpdate({ ...c.scope(user), campaign: campaignId, teacher: teacher._id, class: body.classId }, {
      $set: { status: 'active', grantedBy: user._id, assignedAt: new Date() }, $unset: { revokedBy: 1, revokedAt: 1 }
    }, { new: true, upsert: true, runValidators: true, session });
    await c.audit(user, 'assignment.granted', assignment._id, campaign._id, { teacher: teacher._id, class: body.classId }, session);
    return assignment;
  });
};
exports.revoke = async (user, assignmentId) => {
  c.admin(user); c.id(assignmentId);
  return c.transaction(user, async session => {
    const assignment = await Assignment.findOneAndUpdate({ ...c.scope(user), _id: assignmentId }, { $set: { status: 'revoked', revokedBy: user._id, revokedAt: new Date() } }, { new: true, session });
    if (!assignment) c.fail(404, 'Assignment not found.');
    await c.audit(user, 'assignment.revoked', assignment._id, assignment.campaign, {}, session); return assignment;
  });
};
exports.assignments = async (user, query) => {
  const filter = c.scope(user);
  if (user.role === 'teacher') { filter.teacher = (await c.teacherFor(user))._id; filter.status = 'active'; }
  if (query.campaignId) filter.campaign = c.id(query.campaignId);
  return c.paginated(Assignment, filter, query);
};

// Delete only unused duplicates; never erase payment, remittance or adjustment history.
exports.remove = async (user, campaignId, body) => {
  c.admin(user); c.id(campaignId); c.only(body, ['reason']);
  const reason = c.text(body.reason, 500);
  return c.transaction(user, async session => {
    const filter = { ...c.scope(user), campaign: campaignId };
    const campaign = await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session);
    if (!campaign) c.fail(404, 'Examination not found.');
    if (await Payment.exists(filter).session(session) || await Remittance.exists(filter).session(session) ||
        await Charge.exists({ ...filter, $or: [{ netPaidPesewas: { $ne: 0 } }, { 'adjustments.0': { $exists: true } }] }).session(session)) {
      c.fail(409, 'This examination has payment, handover or adjustment history and cannot be deleted. Close collection to stop new payments.');
    }
    const charges = await Charge.deleteMany(filter, { session });
    const assignments = await Assignment.deleteMany(filter, { session });
    await c.audit(user, 'campaign.deleted', campaign._id, campaign._id, {
      reason, name: campaign.name, academicYear: campaign.academicYear, termName: campaign.termName,
      status: campaign.status, classFees: campaign.classFees.map(fee => ({ class: fee.class, className: fee.className, amountPesewas: fee.amountPesewas })),
      chargesRemoved: charges.deletedCount, assignmentsRemoved: assignments.deletedCount
    }, session);
    await Campaign.deleteOne({ ...c.scope(user), _id: campaignId }, { session });
    return { deletedCampaignId: String(campaign._id) };
  });
};

exports.updateFees = async (user, campaignId, body) => {
  c.admin(user); c.id(campaignId); c.only(body, ['classFees', 'reason', 'expectedRevision']);
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) c.fail(400, 'Invalid examination revision.');
  const reason = c.text(body.reason, 500);
  if (!Array.isArray(body.classFees) || !body.classFees.length || body.classFees.length > 100) c.fail(400, 'Select 1–100 existing classes.');
  const seen = new Set();
  const requested = body.classFees.map(fee => {
    c.only(fee, ['classId', 'amountPesewas']);
    const classId = c.id(fee.classId);
    if (seen.has(String(classId))) c.fail(400, 'Duplicate class.');
    seen.add(String(classId));
    return { classId, amountPesewas: c.money(fee.amountPesewas) };
  });
  return c.transaction(user, async session => {
    const campaign = await Campaign.findOne({ ...c.scope(user), _id: campaignId }).session(session);
    if (!campaign) c.fail(404, 'Examination not found.');
    if (campaign.status !== 'active') c.fail(409, 'Only active examination fees can be updated. Edit draft fees before activation; closed examinations remain locked.');
    const changes = [];
    for (const fee of requested) {
      const existing = campaign.classFees.find(item => String(item.class) === String(fee.classId));
      if (!existing) c.fail(400, 'Only classes already included in this examination can be updated.');
      if (existing.amountPesewas === fee.amountPesewas) continue;
      if (await Charge.exists({ ...c.scope(user), campaign: campaign._id, class: fee.classId, netPaidPesewas: { $gt: fee.amountPesewas } }).session(session)) {
        c.fail(409, `${existing.className}: the new fee is below an amount already paid by a student. No class fees were changed.`);
      }
      changes.push({ classId: fee.classId, className: existing.className, previousAmountPesewas: existing.amountPesewas, amountPesewas: fee.amountPesewas });
    }
    if (changes.length && body.expectedRevision !== undefined && body.expectedRevision !== campaign.revision) c.fail(409, 'Examination fees changed since this form was opened. Close the form, refresh and try again.');
    let chargesAdjusted = 0;
    const now = new Date();
    for (const change of changes) {
      const result = await Charge.updateMany({ ...c.scope(user), campaign: campaign._id, class: change.classId, amountDuePesewas: { $ne: change.amountPesewas } }, [{ $set: {
        adjustments: { $concatArrays: [{ $ifNull: ['$adjustments', []] }, [{ previousAmountPesewas: '$amountDuePesewas', amountDuePesewas: change.amountPesewas, reason: { $literal: reason }, by: user._id, at: now }]] },
        amountDuePesewas: change.amountPesewas, updatedAt: now
      } }], { session });
      chargesAdjusted += result.modifiedCount;
      campaign.classFees.find(item => String(item.class) === String(change.classId)).amountPesewas = change.amountPesewas;
    }
    const definitionChanged = changes.some(change => change.previousAmountPesewas !== change.amountPesewas);
    if (definitionChanged || chargesAdjusted) {
      campaign.revision += 1;
      await campaign.save({ session });
      await c.audit(user, 'campaign.fees_updated', campaign._id, campaign._id, { reason, changes, chargesAdjusted }, session);
    }
    return { campaign, chargesAdjusted };
  });
};
