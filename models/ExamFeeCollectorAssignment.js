const mongoose = require('mongoose');
const { ref } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), campaign: ref('ExamFeeCampaign'), teacher: ref('Teacher'), class: ref('Class'),
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  grantedBy: ref('User'), assignedAt: { type: Date, required: true }, revokedBy: ref('User', false), revokedAt: Date
}, { timestamps: true });
schema.index({ school: 1, campaign: 1, teacher: 1, class: 1 }, { unique: true });
schema.index({ school: 1, teacher: 1, status: 1 });
module.exports = mongoose.model('ExamFeeCollectorAssignment', schema);
