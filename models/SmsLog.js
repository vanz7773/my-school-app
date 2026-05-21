const mongoose = require('mongoose');

const smsLogSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  },
  recipientPhone: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['sent', 'failed', 'pending'],
    default: 'pending'
  },
  messageType: {
    type: String,
    enum: ['attendance', 'fees', 'reports', 'announcements', 'bulk', 'custom', 'system'],
    required: true
  },
  apiResponse: {
    type: mongoose.Schema.Types.Mixed
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Prevent exact duplicate SMS within 24 hours
smsLogSchema.index({ school: 1, recipientPhone: 1, message: 1, sentAt: -1 });

module.exports = mongoose.model('SmsLog', smsLogSchema);
