const { randomUUID } = require('crypto');
const Campaign = require('../../models/ExamFeeCampaign');
const Charge = require('../../models/ExamFeeCharge');
const Student = require('../../models/Student');
const Payment = require('../../models/ExamFeePayment');
const c = require('./core');
const chargeStatus = charge => ({ ...charge, balancePesewas: charge.amountDuePesewas - charge.netPaidPesewas,
  paymentStatus: charge.netPaidPesewas === charge.amountDuePesewas ? 'paid' : charge.netPaidPesewas > 0 ? 'partial' : 'unpaid' });
exports.chargeStatus = chargeStatus;
exports.charges = async (user, query) => {
  const campaign = c.id(query.campaignId);
  const filter = { ...c.scope(user), campaign };
  if (query.classId) filter.class = c.id(query.classId);
  if (user.role === 'teacher' && !filter.class) c.fail(400, 'classId is required.');
  if (filter.class) await c.authorizeClass(user, campaign, filter.class);
  if (query.studentId) filter.student = c.id(query.studentId);
  if (query.status) {
    const status = query.status;
    if (!['paid', 'partial', 'unpaid'].includes(status)) c.fail(400, 'Invalid payment status.');
    filter.$expr = status === 'paid' ? { $eq: ['$netPaidPesewas', '$amountDuePesewas'] } : status === 'unpaid' ?
      { $and: [{ $eq: ['$netPaidPesewas', 0] }, { $gt: ['$amountDuePesewas', 0] }] } :
      { $and: [{ $gt: ['$netPaidPesewas', 0] }, { $lt: ['$netPaidPesewas', '$amountDuePesewas'] }] };
  }
  const result = await c.paginated(Charge, filter, query, { studentName: 1, _id: 1 });
  // Fetch only photos for this authorized page; preserve historical names/classes.
  const students = result.items.length ? await Student.find({ ...c.scope(user), _id: { $in: result.items.map(item => item.student) } })
    .select('_id profilePicture profilePictureThumbnail').lean() : [];
  const photos = new Map(students.map(student => [String(student._id), student]));
  return { ...result, items: result.items.map(item => {
    const photo = photos.get(String(item.student));
    return { ...chargeStatus(item), profilePicture: photo?.profilePicture || '', profilePictureThumbnail: photo?.profilePictureThumbnail || '' };
  }) };
};
exports.record = async (user, body) => {
  c.only(body, ['chargeId', 'amountPesewas', 'method', 'clientRequestId']);
  c.id(body.chargeId); c.money(body.amountPesewas); c.method(body.method); c.requestId(body.clientRequestId);
  return c.transaction(user, async session => {
    const charge = await Charge.findOne({ ...c.scope(user), _id: body.chargeId }).session(session);
    if (!charge) c.fail(404, 'Charge not found.');
    const teacher = await c.authorizeClass(user, charge.campaign, charge.class, session);
    const previous = await Payment.findOne({ ...c.scope(user), clientRequestId: body.clientRequestId }).session(session);
    if (previous) {
      if (String(previous.charge) !== String(c.id(body.chargeId)) || String(previous.collectedBy) !== String(user._id) || previous.amountPesewas !== body.amountPesewas || previous.method !== body.method) c.fail(409, 'clientRequestId was already used for a different payment.');
      return { payment: previous, charge: chargeStatus(charge.toObject()), duplicate: true };
    }
    if (!await Campaign.exists({ ...c.scope(user), _id: charge.campaign, status: 'active' }).session(session)) c.fail(409, 'Collection is not active.');
    const updated = await Charge.findOneAndUpdate({ ...c.scope(user), _id: charge._id,
      $expr: { $gte: [{ $subtract: ['$amountDuePesewas', '$netPaidPesewas'] }, body.amountPesewas] }
    }, { $inc: { netPaidPesewas: body.amountPesewas } }, { new: true, session });
    if (!updated) c.fail(409, 'Payment exceeds the outstanding balance.');
    const [payment] = await Payment.create([{ ...c.scope(user), campaign: charge.campaign, charge: charge._id, student: charge.student, class: charge.class,
      amountPesewas: body.amountPesewas, method: body.method, collectedBy: user._id, teacher: teacher?._id,
      collectorName: user.name || 'Administrator', receiptNumber: `EX-${randomUUID().toUpperCase()}`,
      clientRequestId: body.clientRequestId, recordedAt: new Date(), totalPaidAfterPesewas: updated.netPaidPesewas,
      balanceAfterPesewas: updated.amountDuePesewas - updated.netPaidPesewas }], { session });
    await c.audit(user, 'payment.recorded', payment._id, charge.campaign, { charge: charge._id, amountPesewas: payment.amountPesewas, receiptNumber: payment.receiptNumber }, session);
    return { payment, charge: chargeStatus(updated.toObject()), duplicate: false };
  });
};
exports.reverse = async (user, paymentId, body) => {
  c.admin(user); c.id(paymentId); c.only(body, ['reason']); const reason = c.text(body.reason);
  return c.transaction(user, async session => {
    const payment = await Payment.findOne({ ...c.scope(user), _id: paymentId }).session(session);
    if (!payment) c.fail(404, 'Payment not found.');
    if (payment.status === 'reversed') return payment;
    if (payment.reservedPesewas > 0) c.fail(409, 'Reject pending handovers containing this payment before reversing it.');
    const charge = await Charge.findOneAndUpdate({ ...c.scope(user), _id: payment.charge, netPaidPesewas: { $gte: payment.amountPesewas } },
      { $inc: { netPaidPesewas: -payment.amountPesewas } }, { new: true, session });
    if (!charge) c.fail(409, 'Payment balance could not be reconciled.');
    payment.status = 'reversed'; payment.reversedBy = user._id; payment.reversedAt = new Date(); payment.reversalReason = reason;
    await payment.save({ session });
    await c.audit(user, 'payment.reversed', payment._id, payment.campaign, { reason, amountPesewas: payment.amountPesewas, remittedPesewas: payment.remittedPesewas }, session);
    return payment;
  });
};
exports.adjust = async (user, chargeId, body) => {
  c.admin(user); c.id(chargeId); c.only(body, ['amountDuePesewas', 'reason']); c.money(body.amountDuePesewas, true); const reason = c.text(body.reason);
  return c.transaction(user, async session => {
    const charge = await Charge.findOne({ ...c.scope(user), _id: chargeId }).session(session);
    if (!charge) c.fail(404, 'Charge not found.');
    if (body.amountDuePesewas < charge.netPaidPesewas) c.fail(409, 'Reverse or reconcile payments before reducing the obligation below the amount paid.');
    if (charge.adjustments.length >= 1000) c.fail(409, 'Adjustment limit reached; contact support.');
    const adjustment = { previousAmountPesewas: charge.amountDuePesewas, amountDuePesewas: body.amountDuePesewas, reason, by: user._id, at: new Date() };
    charge.adjustments.push(adjustment); charge.amountDuePesewas = body.amountDuePesewas; await charge.save({ session });
    await c.audit(user, 'charge.adjusted', charge._id, charge.campaign, adjustment, session);
    return chargeStatus(charge.toObject());
  });
};
exports.history = async (user, query) => {
  const filter = c.scope(user);
  if (query.chargeId) {
    const charge = await Charge.findOne({ ...c.scope(user), _id: c.id(query.chargeId) });
    if (!charge) c.fail(404, 'Charge not found.');
    await c.authorizeClass(user, charge.campaign, charge.class); filter.charge = charge._id;
  } else {
    if (query.campaignId) filter.campaign = c.id(query.campaignId);
    if (query.classId) filter.class = c.id(query.classId);
    if (user.role === 'teacher') {
      if (!filter.campaign || !filter.class) c.fail(400, 'Specify a chargeId or campaignId and classId.');
      await c.authorizeClass(user, filter.campaign, filter.class);
    }
  }
  if (query.studentId) filter.student = c.id(query.studentId);
  if (query.teacherId) { c.admin(user); filter.teacher = c.id(query.teacherId); }
  if (query.status) { if (!['recorded', 'reversed'].includes(query.status)) c.fail(400, 'Invalid payment status.'); filter.status = query.status; }
  return c.paginated(Payment, filter, query, { recordedAt: -1, _id: -1 });
};
exports.receiptData = async (user, paymentId) => {
  const payment = await Payment.findOne({ ...c.scope(user), _id: c.id(paymentId) }).lean();
  if (!payment) c.fail(404, 'Payment not found.');
  await c.authorizeClass(user, payment.campaign, payment.class);
  const charge = await Charge.findOne({ ...c.scope(user), _id: payment.charge }).lean();
  const campaign = await Campaign.findOne({ ...c.scope(user), _id: payment.campaign }).lean();
  if (!charge || !campaign) c.fail(409, 'Receipt records are unavailable.');
  return { payment, charge, campaign };
};
