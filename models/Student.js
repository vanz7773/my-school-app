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
    default: ""
  },

  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    default: null   // ⭐ Needed because graduates have no class. Ensure strictPopulate is false if this path is missing in some environments.
  },

  gender: {
    type: String,
    enum: ['Male', 'Female'],
    required: true
  },

  dateOfBirth: { type: Date },
  address: { type: String },
  religion: { type: String },
  hometown: { type: String },
  languageSpoken: { type: String },
  
  // Guardian/Parent Details
  guardianName: { type: String },
  guardianPhone: { type: String },
  guardianPhone2: { type: String },
  guardianOccupation: { type: String },
  fatherName: { type: String },
  fatherOccupation: { type: String },
  motherName: { type: String },
  motherOccupation: { type: String },

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

  status: {
    type: String,
    enum: ['active', 'graduated', 'withdrawn'],
    default: 'active'
  },

  // ⭐ NEW: Admission Register Fields
  surname: { type: String },
  otherNames: { type: String },
  dateOfAdmission: { type: Date },
  lastSchoolAttended: { type: String },
  dateOfLeaving: { type: Date },
  causeForLeaving: { type: String },
  remarks: { type: String }

}, { timestamps: true });

studentSchema.index({ school: 1, class: 1 });
studentSchema.index(
  { school: 1, admissionNumber: 1 },
  { 
    unique: true, 
    partialFilterExpression: { admissionNumber: { $type: "string", $ne: "" } }
  }
);

const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

// Safely attempt to drop the old strict index when connection is ready
mongoose.connection.on('connected', () => {
  if (Student.collection) {
    Student.collection.dropIndex('school_1_admissionNumber_1').catch(err => {
      // Ignore if index does not exist or already dropped
    });
  }
});

module.exports = Student;
