const mongoose = require('mongoose');

const deviceAlertSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  alertType: {
    type: String,
    required: true,
    enum: [
      'Device inactive for 2 hours',
      'Internet disabled during working hours',
      'Possible phone abandonment',
      'Suspicious verification detected'
    ]
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  movementScore: {
    type: String,
    enum: ['VERY_LOW', 'NORMAL', 'HIGH', 'N/A'],
    default: 'N/A'
  },
  stationaryDuration: {
    type: Number,
    default: 0 // In minutes
  },
  offlineDuration: {
    type: Number,
    default: 0 // In minutes
  },
  isReviewed: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

module.exports = mongoose.model('DeviceAlert', deviceAlertSchema);
