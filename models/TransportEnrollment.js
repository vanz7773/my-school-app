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
    required: true,
  },
  academicYear: {
    type: String,
    required: true,
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
}, { timestamps: true });

// Ensure a student is only enrolled in one route per term
transportEnrollmentSchema.index({ student: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('TransportEnrollment', transportEnrollmentSchema);
