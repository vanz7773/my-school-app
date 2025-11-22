const mongoose = require('mongoose');

const studentAttendanceSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
    },

    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },

    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      required: true,
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },

    // 🆕 New field for compatibility — stores the week label or number as a string
    week: {
      type: String,
      default: '', // e.g. "Week 1" or "1"
    },

    weekNumber: {
      type: Number,
      required: true,
    },

    weekStartDate: {
      type: Date,
      default: Date.now, // overwritten by actual term week start
    },

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

    totalPresent: {
      type: Number,
      default: 0,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    initializer: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      role: { type: String },
    },
  },
  { timestamps: true }
);

/**
 * ✅ Compound unique index:
 * Prevents duplicates for same student, week, class, and term.
 */
studentAttendanceSchema.index(
  { school: 1, class: 1, termId: 1, student: 1, weekNumber: 1 },
  { unique: true }
);

/**
 * 🧹 Pre-save hook to clean up old/legacy indexes.
 * Ensures migration from older versions doesn’t break inserts.
 */
studentAttendanceSchema.pre('save', async function (next) {
  try {
    const collection = this.constructor.collection;
    const indexes = await collection.indexes();
    const legacyIndex = indexes.find(
      (idx) => idx.key && idx.key.student === 1 && idx.key.date === 1
    );

    if (legacyIndex) {
      console.log(`🧹 Removing legacy index: ${legacyIndex.name}`);
      await collection.dropIndex(legacyIndex.name);
    }
  } catch (err) {
    console.warn('⚠️ Could not check/remove legacy index:', err.message);
  }
  next();
});

module.exports =
  mongoose.models.StudentAttendance ||
  mongoose.model('StudentAttendance', studentAttendanceSchema);
