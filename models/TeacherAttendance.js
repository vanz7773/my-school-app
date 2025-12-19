const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
// Teacher Attendance Schema
// ─────────────────────────────────────────────────────────────
const teacherAttendanceSchema = new mongoose.Schema({
  teacher: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Teacher', 
    required: true 
  },
  school: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'School', 
    required: true 
  },
  term: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Term', 
    required: true 
  },
  date: { 
    type: Date, 
    required: true 
  },
  signInTime: { 
    type: Date, 
    default: null 
  },
  signOutTime: { 
    type: Date, 
    default: null 
  },
  status: {
    type: String,
    enum: ['On Time', 'Late', 'Absent'], // ✅ UPDATED
    default: 'Absent'                    // ✅ SAFE DEFAULT
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0]
    }
  }
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────
// Unique index per teacher per day
// Ensure date is normalized to start of day when saving
// ─────────────────────────────────────────────────────────────
teacherAttendanceSchema.index({ teacher: 1, date: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────
// Normalize date before saving (critical for auto-absence)
// ─────────────────────────────────────────────────────────────
teacherAttendanceSchema.pre('save', function(next) {
  if (this.date) {
    const d = new Date(this.date);
    d.setHours(0, 0, 0, 0);
    this.date = d;
  }
  next();
});

module.exports = mongoose.model('TeacherAttendance', teacherAttendanceSchema);
