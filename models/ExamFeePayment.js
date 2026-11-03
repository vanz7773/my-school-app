const mongoose = require('mongoose');
const { ref, money, methods } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), campaign: ref('ExamFeeCampaign'), charge: ref('ExamFeeCharge'), student: ref('Student'), class: ref('Class'),
  amountPesewas: money(1), method: { type: String, enum: methods, required: true }, collectedBy: ref('User'), teacher: ref('Teacher', false),
  collectorName: { type: String, required: true }, receiptNumber: { type: String, required: true }, clientRequestId: { type: String, required: true, maxlength: 100 },
  status: { type: String, enum: ['recorded', 'reversed'], default: 'recorded' }, recordedAt: { type: Date, required: true },
  totalPaidAfterPesewas: money(), balanceAfterPesewas: money(),
  reservedPesewas: { ...money(), default: 0 }, remittedPesewas: { ...money(), default: 0 },
  reversedBy: ref('User', false), reversedAt: Date, reversalReason: { type: String, maxlength: 500 }
}, { timestamps: true });
schema.index({ school: 1, clientRequestId: 1 }, { unique: true });
schema.index({ receiptNumber: 1 }, { unique: true });
schema.index({ school: 1, campaign: 1, class: 1, recordedAt: -1 });
schema.index({ school: 1, charge: 1, recordedAt: -1 });
schema.index({ school: 1, teacher: 1, campaign: 1, status: 1 });
module.exports = mongoose.model('ExamFeePayment', schema);
