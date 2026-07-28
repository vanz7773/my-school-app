const mongoose = require('mongoose');

const dayStatus = {
  type: String,
  enum: ['paid', 'unpaid', 'absent', 'notmarked'],
  default: 'notmarked',
};

const moneyByDay = {
  M: { type: Number, default: 0 },
  T: { type: Number, default: 0 },
  W: { type: Number, default: 0 },
  TH: { type: Number, default: 0 },
  F: { type: Number, default: 0 },
};

const classFeeRecordSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true,
    },
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      required: true,
      index: true,
    },
    week: {
      type: Number,
      required: true,
      min: 1,
      index: true,
    },
    classFeeAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCollected: {
      type: Number,
      default: 0,
      min: 0,
    },
    paidCount: { type: Number, default: 0, min: 0 },
    unpaidCount: { type: Number, default: 0, min: 0 },
    absentCount: { type: Number, default: 0, min: 0 },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    breakdown: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Student',
          required: true,
        },
        studentName: String,
        className: String,
        classFeeAmount: { type: Number, default: 0, min: 0 },
        days: {
          M: dayStatus,
          T: dayStatus,
          W: dayStatus,
          TH: dayStatus,
          F: dayStatus,
        },
        perDayFee: moneyByDay,
        total: { type: Number, default: 0, min: 0 },
        daysPaid: { type: Number, default: 0, min: 0 },
        paidAt: {
          M: { type: Date, default: null },
          T: { type: Date, default: null },
          W: { type: Date, default: null },
          TH: { type: Date, default: null },
          F: { type: Date, default: null },
        },
        lastUpdatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        lastUpdatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

classFeeRecordSchema.index(
  { school: 1, classId: 1, termId: 1, week: 1 },
  { unique: true }
);
classFeeRecordSchema.index({ school: 1, 'breakdown.student': 1 });

const DAY_KEYS = ['M', 'T', 'W', 'TH', 'F'];

const normalizeStatus = (value) => {
  if (value === true || value === 'present' || value === 'paid') return 'paid';
  if (value === false || value === 'absent') return 'absent';
  if (value === 'unpaid') return 'unpaid';
  return 'notmarked';
};

classFeeRecordSchema.pre('save', function updateTotals(next) {
  this.lastUpdatedAt = Date.now();

  let totalCollected = 0;
  let paidCount = 0;
  let unpaidCount = 0;
  let absentCount = 0;

  for (const entry of this.breakdown || []) {
    let entryTotal = 0;
    let daysPaid = 0;
    const perDayFee = { M: 0, T: 0, W: 0, TH: 0, F: 0 };

    for (const day of DAY_KEYS) {
      const status = normalizeStatus(entry.days?.[day]);
      entry.days[day] = status;

      if (status === 'paid') {
        const dayAmount = Number(entry.classFeeAmount ?? this.classFeeAmount) || 0;
        perDayFee[day] = dayAmount;
        entryTotal += dayAmount;
        daysPaid += 1;
        paidCount += 1;
      } else if (status === 'unpaid') {
        unpaidCount += 1;
      } else if (status === 'absent') {
        absentCount += 1;
      }
    }

    entry.perDayFee = perDayFee;
    entry.total = entryTotal;
    entry.daysPaid = daysPaid;
    totalCollected += entryTotal;
  }

  this.totalCollected = totalCollected;
  this.paidCount = paidCount;
  this.unpaidCount = unpaidCount;
  this.absentCount = absentCount;

  next();
});

module.exports =
  mongoose.models.ClassFeeRecord ||
  mongoose.model('ClassFeeRecord', classFeeRecordSchema);
