const mongoose = require('mongoose');

const schoolSmsSettingsSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    unique: true
  },
  smsEnabled: {
    type: Boolean,
    default: false
  },
  smsBalance: {
    type: Number,
    default: 0
  },
  senderId: {
    type: String,
    maxLength: 11,
    trim: true
  },
  autoTriggers: {
    feesOverdue: { type: Boolean, default: false },
    examReports: { type: Boolean, default: false },
    announcements: { type: Boolean, default: false }
  }
}, { timestamps: true });

module.exports = mongoose.model('SchoolSmsSettings', schoolSmsSettingsSchema);
