const mongoose = require('mongoose');

const deviceActivityLogSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  steps: {
    type: Number,
    default: 0
  },
  tiltDetected: {
    type: Boolean,
    default: false
  },
  movementLevel: {
    type: String,
    enum: ['HIGH', 'MEDIUM', 'LOW', 'NONE'],
    default: 'NONE'
  },
  internetStatus: {
    type: String,
    enum: ['online', 'offline'],
    default: 'online'
  },
  stationaryState: {
    type: Boolean,
    default: false
  },
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },
  geofenceStatus: {
    type: String,
    enum: ['inside', 'radius', 'outside', null],
    default: null
  },
  distanceFromSchool: {
    type: Number,
    default: 0
  },
  geofenceViolation: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

module.exports = mongoose.model('DeviceActivityLog', deviceActivityLogSchema);
