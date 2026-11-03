const mongoose = require('mongoose');
const { ref, money } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), name: { type: String, required: true, trim: true, maxlength: 120 },
  examinationType: { type: String, enum: ['end_of_term', 'mock'], required: true },
  academicYear: { type: String, required: true }, term: ref('Term'), termName: { type: String, required: true },
  classFees: [{ _id: false, class: ref('Class'), className: { type: String, required: true }, amountPesewas: money(1) }],
  status: { type: String, enum: ['draft', 'active', 'closed'], default: 'draft' },
  createdBy: ref('User'), activatedBy: ref('User', false), activatedAt: Date, closedBy: ref('User', false), closedAt: Date,
  revision: { type: Number, default: 0 }
}, { timestamps: true });
schema.index({ school: 1, academicYear: 1, term: 1, status: 1 });
module.exports = mongoose.model('ExamFeeCampaign', schema);
