const mongoose = require('mongoose');
const { ref, money } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), campaign: ref('ExamFeeCampaign'), student: ref('Student'), class: ref('Class'),
  studentName: { type: String, required: true }, admissionNumber: String, className: { type: String, required: true },
  originalAmountPesewas: money(), amountDuePesewas: money(), netPaidPesewas: { ...money(), default: 0 },
  adjustments: [{ _id: false, previousAmountPesewas: money(), amountDuePesewas: money(), reason: { type: String, required: true, maxlength: 500 }, by: ref('User'), at: { type: Date, required: true } }]
}, { timestamps: true });
schema.index({ school: 1, campaign: 1, student: 1 }, { unique: true });
schema.index({ school: 1, campaign: 1, class: 1, _id: 1 });
module.exports = mongoose.model('ExamFeeCharge', schema);
