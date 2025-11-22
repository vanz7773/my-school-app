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
  signInTime: { type: Date },
  signOutTime: { type: Date },
  status: {
    type: String,
    enum: ['On Time', 'Late'],
    default: 'On Time'
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

// Optional: Normalize date before saving to avoid duplicates
teacherAttendanceSchema.pre('save', function(next) {
  if (this.date) {
    const d = new Date(this.date);
    d.setHours(0, 0, 0, 0);
    this.date = d;
  }
  next();
});

module.exports = mongoose.model('TeacherAttendance', teacherAttendanceSchema);
