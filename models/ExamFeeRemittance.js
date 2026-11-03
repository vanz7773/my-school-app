const mongoose = require('mongoose');
const { ref, money, methods } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), campaign: ref('ExamFeeCampaign'), teacher: ref('Teacher'), submittedBy: ref('User'),
  amountPesewas: money(1), method: { type: String, enum: methods, required: true },
  clientRequestId: { type: String, required: true, maxlength: 100 },
  submittedAt: { type: Date, required: true }, status: { type: String, enum: ['submitted', 'confirmed', 'rejected'], default: 'submitted' },
  confirmedBy: ref('User', false), confirmedAt: Date, rejectedBy: ref('User', false), rejectedAt: Date, rejectionReason: String,
  notes: { type: String, maxlength: 500 }, allocations: [{ _id: false, payment: ref('ExamFeePayment'), amountPesewas: money(1) }]
}, { timestamps: true });
schema.index({ school: 1, clientRequestId: 1 }, { unique: true });
schema.index({ school: 1, campaign: 1, teacher: 1, status: 1 });
module.exports = mongoose.model('ExamFeeRemittance', schema);
