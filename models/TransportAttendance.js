const mongoose = require('mongoose');

const transportAttendanceSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  route: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TransportRoute',
    required: true,
  },
  assignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TransportAssignment',
    required: true,
  },
  date: {
    type: String, // Format: YYYY-MM-DD
    required: true,
  },
  boarded: {
    type: Boolean,
    default: false,
  },
  boardedAt: {
    type: Date,
  },
  exited: {
    type: Boolean,
    default: false,
  },
  exitedAt: {
    type: Date,
  },
  exitStop: {
    type: String,
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },
}, { timestamps: true });

// A student can only have one attendance record per day
transportAttendanceSchema.index({ student: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TransportAttendance', transportAttendanceSchema);
