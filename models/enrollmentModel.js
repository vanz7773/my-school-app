const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true
  },
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true
  },
  academicYear: {
    type: String,
    required: true // e.g. "2024/2025"
  },
  term: {
    type: String,
    enum: ['1st Term', '2nd Term', '3rd Term'],
    required: true
  },
  enrolledAt: {
    type: Date,
    default: Date.now
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
