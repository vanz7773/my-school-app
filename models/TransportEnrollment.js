const mongoose = require('mongoose');

const transportEnrollmentSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  term: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Term',
    required: false,
  },
  academicYear: {
    type: String,
    required: false,
  },
  bus: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
  },
  route: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TransportRoute',
    required: true,
  },
  stop: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },
  feeAmount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

// Ensure a student has only one transport enrollment per school (persistent)
transportEnrollmentSchema.index({ student: 1, school: 1 }, { unique: true });

module.exports = mongoose.model('TransportEnrollment', transportEnrollmentSchema);
