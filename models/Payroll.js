const mongoose = require('mongoose');

const payslipSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  teacherName: String, // Snapshot
  schoolName: String,
  teacherLevel: String,
  teacherDateOfBirth: Date,
  employeeId: String,
  baseSalary: Number,
  earnings: [{
    name: String,
    amount: Number
  }],
  deductions: [{
    name: String,
    amount: Number,
    isAttendancePenalty: { type: Boolean, default: false } // e.g. Late or Absent
  }],
  attendanceData: {
    present: Number,
    absent: Number,
    late: Number,
    totalWorkingDays: Number
  },
  grossSalary: Number,
  annualSalary: Number,
  ytdGross: Number,
  totalDeductions: Number,
  netSalary: Number,
  paymentDate: Date,
  referenceNumber: String,
  accountDetails: {
    bankName: String,
    accountNumber: String,
    accountName: String,
    ssnitNumber: String
  }
});

const payrollSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  month: { type: String, required: true }, // e.g. "2026-05"
  status: { type: String, enum: ['Draft', 'Approved', 'Paid'], default: 'Draft' },
  payslips: [payslipSchema],
  totalGross: Number,
  totalDeductions: Number,
  totalNet: Number,
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  paidAt: Date
}, { timestamps: true });

// Ensure only one payroll per month per school
payrollSchema.index({ school: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', payrollSchema);
