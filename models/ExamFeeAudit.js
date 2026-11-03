const mongoose = require('mongoose');
const { ref } = require('./examFeeFields');
const schema = new mongoose.Schema({
  school: ref('School'), actor: ref('User'), action: { type: String, required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true }, campaign: ref('ExamFeeCampaign', false),
  details: mongoose.Schema.Types.Mixed
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ school: 1, campaign: 1, createdAt: -1 });
module.exports = mongoose.model('ExamFeeAudit', schema);
