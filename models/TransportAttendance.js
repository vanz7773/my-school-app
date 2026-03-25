const mongoose = require('mongoose');

const transportAttendanceSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  bus: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
  },
  routeSnapshot: {
    type: String,
    required: true,
  },
  stopSnapshot: {
    type: String,
    required: true,
  },
  assignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TransportAssignment',
  },
  date: {
    type: String, // Format: YYYY-MM-DD
    required: true,
  },
  picked: {
    type: Boolean,
    default: false,
  },
  pickedAt: {
    type: Date,
  },
  dropped: {
    type: Boolean,
    default: false,
  },
  droppedAt: {
    type: Date,
  },
  markedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
