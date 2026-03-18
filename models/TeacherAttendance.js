const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
// Teacher Attendance Schema (One record per teacher per day)
// ─────────────────────────────────────────────────────────────
const teacherAttendanceSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      required: true,
      index: true,
    },

    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },

    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      required: true,
      index: true,
    },

    // Normalized to start of day (00:00:00)
    date: {
      type: Date,
      required: true,
      index: true,
    },

    // Clock-in timestamp (set once)
    signInTime: {
      type: Date,
      default: null,
    },

    // Clock-out timestamp (set once)
    signOutTime: {
      type: Date,
      default: null,
    },

    // Explicit attendance state
    status: {
      type: String,
      enum: ['Absent', 'On Time', 'Late', 'Holiday'],
      default: 'Absent',
      index: true,
    },

    // Last known valid location (ONLY set on clock-in/out)
    // ⚠️ Must NEVER exist without coordinates
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined, // 🚀 CRITICAL: Prevents Mongoose from defaulting to [] which breaks GeoJSON index
        validate: {
          validator: function (v) {
            // Allow undefined (Absent records)
            if (!v) return true;
            return Array.isArray(v) && v.length === 2;
          },
          message: 'Location coordinates must be [longitude, latitude]',
        },
      },
    },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────
// Enforce ONE attendance document per teacher per day
// ─────────────────────────────────────────────────────────────
teacherAttendanceSchema.index(
  { teacher: 1, date: 1 },
  { unique: true }
);

// ─────────────────────────────────────────────────────────────
// Normalize date to start of day (CRITICAL)
// Prevents midnight duplication & flip-flopping
// ─────────────────────────────────────────────────────────────
teacherAttendanceSchema.pre('validate', function (next) {
  if (this.date instanceof Date) {
    const normalized = new Date(this.date);
    normalized.setHours(0, 0, 0, 0);
    this.date = normalized;
  }
  next();
});

// ─────────────────────────────────────────────────────────────
// SAFETY GUARD:
// If location.type exists without coordinates → remove location
// Prevents accidental invalid GeoJSON writes
// ─────────────────────────────────────────────────────────────
teacherAttendanceSchema.pre('save', function (next) {
  if (this.location?.type && !this.location.coordinates) {
    this.location = undefined;
  }
  next();
});

// ⚡ Optimize querying attendance across the whole school on a specific date (e.g. daily attendance report)
teacherAttendanceSchema.index({ school: 1, date: -1 });

// ⚡ Optimize querying a specific teacher's attendance for the entire term
teacherAttendanceSchema.index({ school: 1, teacher: 1, term: 1 });

module.exports = mongoose.model(
  'TeacherAttendance',
  teacherAttendanceSchema
);
