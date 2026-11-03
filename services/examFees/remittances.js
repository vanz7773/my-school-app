const mongoose = require('mongoose');
const Payment = require('../../models/ExamFeePayment');
const Remittance = require('../../models/ExamFeeRemittance');
const Campaign = require('../../models/ExamFeeCampaign');
const c = require('./core');
exports.submit = async (user, body) => {
  if (user.role !== 'teacher') c.fail(403, 'Teacher access required.');
  c.only(body, ['campaignId', 'amountPesewas', 'method', 'clientRequestId', 'notes']);
  c.id(body.campaignId); c.money(body.amountPesewas); c.method(body.method); c.requestId(body.clientRequestId);
  const notes = body.notes ? c.text(body.notes) : '';
  return c.transaction(user, async session => {
    const teacher = await c.teacherFor(user, session);
    const previous = await Remittance.findOne({ ...c.scope(user), clientRequestId: body.clientRequestId }).session(session);
    if (previous) {
      if (String(previous.teacher) !== String(teacher._id) || String(previous.campaign) !== String(c.id(body.campaignId)) || previous.amountPesewas !== body.amountPesewas || previous.method !== body.method || previous.notes !== notes) c.fail(409, 'clientRequestId was already used for a different handover.');
      return previous;
    }
    if (!await Campaign.exists({ ...c.scope(user), _id: body.campaignId, status: { $in: ['active', 'closed'] } }).session(session)) c.fail(404, 'Campaign not found.');
    const net = await Payment.aggregate([{ $match: { school: teacher.school, campaign: new mongoose.Types.ObjectId(body.campaignId), teacher: teacher._id } },
      { $group: { _id: null, collected: { $sum: { $cond: [{ $eq: ['$status', 'recorded'] }, '$amountPesewas', 0] } },
        committed: { $sum: { $add: ['$remittedPesewas', '$reservedPesewas'] } } } }]).session(session);
    if (!net[0] || body.amountPesewas > net[0].collected - net[0].committed) c.fail(409, 'Handover exceeds net collections after reversals and prior handovers.');
    // Historical funds remain accountable even if collection authorization is revoked.
    const cursor = Payment.find({ ...c.scope(user), campaign: body.campaignId, teacher: teacher._id, collectedBy: user._id, status: 'recorded',
      $expr: { $gt: ['$amountPesewas', { $add: ['$remittedPesewas', '$reservedPesewas'] }] }
    }).sort({ recordedAt: 1, _id: 1 }).session(session).cursor();
    let remaining = body.amountPesewas; const allocations = [];
    for await (const payment of cursor) {
      const allocated = Math.min(remaining, payment.amountPesewas - payment.remittedPesewas - payment.reservedPesewas);
      allocations.push({ payment: payment._id, amountPesewas: allocated });
      await Payment.updateOne({ ...c.scope(user), _id: payment._id }, { $inc: { reservedPesewas: allocated } }, { session });
      remaining -= allocated;
      if (!remaining) break;
      if (allocations.length >= 1000) c.fail(400, 'Submit a smaller handover (maximum 1,000 payment allocations).');
    }
    if (remaining) c.fail(409, 'Handover exceeds unreserved collections.');
    const [remittance] = await Remittance.create([{ ...c.scope(user), campaign: body.campaignId, teacher: teacher._id,
      submittedBy: user._id, amountPesewas: body.amountPesewas, method: body.method, clientRequestId: body.clientRequestId,
      submittedAt: new Date(), notes, allocations }], { session });
    await c.audit(user, 'remittance.submitted', remittance._id, remittance.campaign, { amountPesewas: body.amountPesewas, allocations }, session);
    return remittance;
  });
};
exports.resolve = async (user, remittanceId, body, confirm) => {
  c.admin(user); c.id(remittanceId); c.only(body, confirm ? [] : ['reason']);
  const reason = confirm ? '' : c.text(body.reason);
  return c.transaction(user, async session => {
    const remittance = await Remittance.findOne({ ...c.scope(user), _id: remittanceId }).session(session);
    if (!remittance) c.fail(404, 'Handover not found.');
    const target = confirm ? 'confirmed' : 'rejected';
    if (remittance.status === target) return remittance;
    if (remittance.status !== 'submitted') c.fail(409, 'Handover is already resolved.');
    for (const allocation of remittance.allocations) {
      const changed = await Payment.updateOne({ ...c.scope(user), _id: allocation.payment, teacher: remittance.teacher,
        campaign: remittance.campaign, status: 'recorded', reservedPesewas: { $gte: allocation.amountPesewas }
      }, { $inc: { reservedPesewas: -allocation.amountPesewas, ...(confirm ? { remittedPesewas: allocation.amountPesewas } : {}) } }, { session });
      if (changed.modifiedCount !== 1) c.fail(409, 'Handover allocations could not be reconciled.');
    }
    remittance.status = target;
    if (confirm) { remittance.confirmedBy = user._id; remittance.confirmedAt = new Date(); }
    else { remittance.rejectedBy = user._id; remittance.rejectedAt = new Date(); remittance.rejectionReason = reason; }
    await remittance.save({ session });
    await c.audit(user, `remittance.${target}`, remittance._id, remittance.campaign, { reason, amountPesewas: remittance.amountPesewas }, session);
    return remittance;
  });
};
exports.list = async (user, query) => {
  const filter = c.scope(user);
  if (user.role === 'teacher') filter.teacher = (await c.teacherFor(user))._id;
  else if (query.teacherId) filter.teacher = c.id(query.teacherId);
  if (query.campaignId) filter.campaign = c.id(query.campaignId);
  if (query.status) { if (!['submitted', 'confirmed', 'rejected'].includes(query.status)) c.fail(400, 'Invalid handover status.'); filter.status = query.status; }
  return c.paginated(Remittance, filter, query);
};
