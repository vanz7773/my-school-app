const mongoose = require('mongoose');

/**
 * Tracks a student paying the full week's transport fee to the teacher.
 * weekLabel  - e.g. "Week 4"  (matches /term/weeks label)
 * termId     - the Term document ID
 * daysCount  - how many school days were billed (default 5)
 * totalAmount - feeAmount × daysCount (computed before saving)
 * recordedBy - Teacher who accepted the payment
 */
const transportWeeklyFeePaymentSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  enrollment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TransportEnrollment',
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
  weekLabel: {
    type: String,  // e.g. "Week 4"
    required: true,
  },
  date: {
    type: String,  // e.g. "2026-03-28"
    required: true,
  },
  daysCount: {
    type: Number,
    default: 5,
  },
  dailyRate: {
    type: Number,
    required: true,
  },
  totalAmount: {
    type: Number,
    required: true,
  },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'MoMo', 'Cheque', 'Other'],
    default: 'Cash',
  },
  notes: { type: String, default: '' },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Teacher',
  },
}, { timestamps: true });

// Prevent duplicate payment for the same student on the same day
transportWeeklyFeePaymentSchema.index(
  { student: 1, date: 1 },
  { unique: true }
);

module.exports = mongoose.model('TransportWeeklyFeePayment', transportWeeklyFeePaymentSchema);
