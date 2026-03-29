const mongoose = require('mongoose');

const transportFeeRecordSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
    },
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      required: true,
    },
    academicYear: {
      type: String,
      required: true,
    },
    week: {
      type: Number,
      required: true,
    },
    // The specific bus or assignment that this record correlates to (can be optional mapping)
    busId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
    },
    totalCollected: {
      type: Number,
      default: 0,
    },
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
        dailyRate: { type: Number, default: 0 },
        days: {
          M: { type: String, enum: ['boarded', 'absent', 'notmarked'], default: 'notmarked' },
          T: { type: String, enum: ['boarded', 'absent', 'notmarked'], default: 'notmarked' },
          W: { type: String, enum: ['boarded', 'absent', 'notmarked'], default: 'notmarked' },
          TH: { type: String, enum: ['boarded', 'absent', 'notmarked'], default: 'notmarked' },
          F: { type: String, enum: ['boarded', 'absent', 'notmarked'], default: 'notmarked' },
        },
        perDayFee: {
          M: { type: Number, default: 0 },
          T: { type: Number, default: 0 },
          W: { type: Number, default: 0 },
          TH: { type: Number, default: 0 },
          F: { type: Number, default: 0 }
        },
        total: { type: Number, default: 0 },
        daysBoarded: { type: Number, default: 0 },
        isRecoveredDebt: { type: Boolean, default: false },
        currency: { type: String, default: 'GHS' },
        routeSnapshot: String,
        stopSnapshot: String
      }
    ]
  },
  { timestamps: true }
);

// Pre-save hook to mathematically recalculate fees
transportFeeRecordSchema.pre('save', function (next) {
  let recordTotalCollected = 0; // if we track total across all students here

  this.breakdown.forEach((entry) => {
    let studentTotal = 0;
    let daysBoardedCount = 0;

    ['M', 'T', 'W', 'TH', 'F'].forEach((day) => {
      if (entry.days[day] === 'boarded') {
        const fee = entry.dailyRate || 0;
        entry.perDayFee[day] = fee;
        studentTotal += fee;
        daysBoardedCount += 1;
      } else {
        entry.perDayFee[day] = 0;
      }
    });

    entry.total = studentTotal;
    entry.daysBoarded = daysBoardedCount;
  });

  next();
});

// Ensure compound index for fast queries
transportFeeRecordSchema.index({ school: 1, termId: 1, week: 1 }, { unique: false });

module.exports = mongoose.model('TransportFeeRecord', transportFeeRecordSchema);
