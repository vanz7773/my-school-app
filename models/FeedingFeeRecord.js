const mongoose = require('mongoose');

const feedingFeeRecordSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      required: true,
    },
    week: {
      type: Number,
      required: true,
    },
    // Remove category field since we're using class-based system
    // category: {
    //   type: String,
    //   enum: ['creche-kg2', 'basic1-6', 'basic7-9'],
    //   required: true,
    // },
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
    // Add config type for reporting
    configType: {
      type: String,
      enum: ['category-based', 'class-based'],
      default: 'class-based'
    },
    // Add class fee amount for this record
    classFeeAmount: {
      type: Number,
      default: 0
    },

    breakdown: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Student',
          required: true,
        },
        studentName: String, // Added for display purposes
        className: String,   // Added for display purposes
        classFeeAmount: Number, // The fee per day for this student's class

        // Enhanced days tracking with fee calculation
        days: {
          M: {
            type: String,
            enum: ['present', 'absent', 'notmarked'],
            default: 'notmarked',
          },
          T: {
            type: String,
            enum: ['present', 'absent', 'notmarked'],
            default: 'notmarked',
          },
          W: {
            type: String,
            enum: ['present', 'absent', 'notmarked'],
            default: 'notmarked',
          },
          TH: {
            type: String,
            enum: ['present', 'absent', 'notmarked'],
            default: 'notmarked',
          },
          F: {
            type: String,
            enum: ['present', 'absent', 'notmarked'],
            default: 'notmarked',
          },
        },

        // Add per-day fee calculation
        perDayFee: {
          M: { type: Number, default: 0 },
          T: { type: Number, default: 0 },
          W: { type: Number, default: 0 },
          TH: { type: Number, default: 0 },
          F: { type: Number, default: 0 }
        },

        // Replace 'amount' with 'total' for clarity
        total: {
          type: Number,
          default: 0,
        },

        // Keep daysPaid for quick reference
        daysPaid: {
          type: Number,
          default: 0,
        },

        // Track if this payment was a retroactive debt recovery
        isRecoveredDebt: {
          type: Boolean,
          default: false
        },

        currency: {
          type: String,
          default: 'GHS'
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

// 🔒 Prevent duplicates for same class/week/term/school
feedingFeeRecordSchema.index(
  { school: 1, classId: 1, termId: 1, week: 1 },
  { unique: true }
);

// 🧩 Enhanced pre-save hook to calculate fees based on class-based system
feedingFeeRecordSchema.pre('save', function (next) {
  this.lastUpdatedAt = Date.now();

  let totalCollected = 0;

  // Process each breakdown entry
  for (const entry of this.breakdown || []) {
    // Convert boolean/null to tri-state strings
    if (entry.days) {
      for (const day of ['M', 'T', 'W', 'TH', 'F']) {
        const val = entry.days[day];
        if (val === true) entry.days[day] = 'present';
        else if (val === false) entry.days[day] = 'absent';
        else if (val == null) entry.days[day] = 'notmarked';
      }
    }

    // Calculate per-day fees and total
    let daysPaid = 0;
    let entryTotal = 0;
    const perDayFee = { M: 0, T: 0, W: 0, TH: 0, F: 0 };

    // Calculate fees for each day based on attendance
    for (const day of ['M', 'T', 'W', 'TH', 'F']) {
      if (entry.days && entry.days[day] === 'present') {
        const dayFee = entry.classFeeAmount || this.classFeeAmount || 0;
        perDayFee[day] = dayFee;
        entryTotal += dayFee;
        daysPaid++;
      } else {
        perDayFee[day] = 0;
      }
    }

    // Update entry with calculated values
    entry.perDayFee = perDayFee;
    entry.total = entryTotal;
    entry.daysPaid = daysPaid;

    totalCollected += entryTotal;
  }

  // Update the total collected for the entire record
  this.totalCollected = totalCollected;

  next();
});

// 🧩 Enhanced pre-update hook for findOneAndUpdate
feedingFeeRecordSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();

  // Handle breakdown updates
  if (update?.$set?.['breakdown']) {
    for (const entry of update.$set.breakdown) {
      if (entry.days) {
        for (const day of ['M', 'T', 'W', 'TH', 'F']) {
          const val = entry.days[day];
          if (val === true) entry.days[day] = 'present';
          else if (val === false) entry.days[day] = 'absent';
          else if (val == null) entry.days[day] = 'notmarked';
        }
      }
    }
  }

  // If we're updating the breakdown, we should recalculate totals
  if (update?.breakdown || update?.$set?.breakdown) {
    const breakdown = update.breakdown || update.$set.breakdown;
    let totalCollected = 0;

    for (const entry of breakdown) {
      let entryTotal = 0;
      for (const day of ['M', 'T', 'W', 'TH', 'F']) {
        if (entry.days && entry.days[day] === 'present') {
          const dayFee = entry.classFeeAmount || 0;
          entryTotal += dayFee;
        }
      }
      entry.total = entryTotal;
      totalCollected += entryTotal;
    }

    update.$set = update.$set || {};
    update.$set.totalCollected = totalCollected;
    update.$set.lastUpdatedAt = Date.now();
  }

  next();
});

module.exports =
  mongoose.models.FeedingFeeRecord ||
  mongoose.model('FeedingFeeRecord', feedingFeeRecordSchema);