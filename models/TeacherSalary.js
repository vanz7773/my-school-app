const mongoose = require('mongoose');

const teacherSalarySchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true, unique: true },
  baseSalary: { type: Number, required: true, default: 0 },
  allowances: [{
    name: String,
    amount: Number
  }],
  deductions: [{
    name: String,
    amount: Number
  }],
  accountDetails: {
    bankName: String,
    accountNumber: String,
    accountName: String,
    ssnitNumber: String
  }
}, { timestamps: true });

// Prevent multiple salary structures for one teacher
teacherSalarySchema.index({ school: 1, teacher: 1 }, { unique: true });

module.exports = mongoose.model('TeacherSalary', teacherSalarySchema);
