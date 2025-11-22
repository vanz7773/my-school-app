const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },

  admissionNumber: {
    type: String,
    required: true,
    unique: true
  },

  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    default: null   // ⭐ Needed because graduates have no class
  },

  gender: {
    type: String,
    enum: ['Male', 'Female'],
    required: true
  },

  dateOfBirth: { type: Date },
  address: { type: String },
  guardianName: { type: String },
  guardianPhone: { type: String },

  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  },

  academicYear: {
    type: String,
    required: true  // Example: "2025 to 2026"
  },

  parentIds: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  ],

  // ⭐ Report Card storage
  reportCards: {
    type: Map,
    of: String,
    default: {}
  },

  // ⭐ NEW: Graduation / Active Status
  status: {
    type: String,
    enum: ['active', 'graduated', 'withdrawn'],
    default: 'active'
  }

}, { timestamps: true });

studentSchema.index({ school: 1, class: 1 });

module.exports =
  mongoose.models.Student || mongoose.model('Student', studentSchema);
