const mongoose = require('mongoose');

const teacherSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },

  // Classes this teacher teaches
  assignedClasses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Class' }],

  // ⭐ Multi-subject support
  subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }],

  phone: { type: String },
  bio: { type: String },

  deviceId: { type: String, default: null },
  deviceName: { type: String, default: '' },
  deviceBoundAt: { type: Date, default: null },

  movements: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Movement', default: [] }],
}, { timestamps: true });

// Always ensure movements is an array
teacherSchema.pre('save', function (next) {
  if (!Array.isArray(this.movements)) {
    this.movements = [];
  }
  next();
});

// --------------------------------------------------------------------
// ⚡ PERFORMANCE INDEXES
// --------------------------------------------------------------------
// Optimize fetching a specific teacher's profile via their User ID
teacherSchema.index({ user: 1 });

// Optimize Admin dashboard fetching all teachers for a school
teacherSchema.index({ school: 1 });

// Optimize finding teachers assigned to a specific class (e.g., timetable or class pages)
teacherSchema.index({ school: 1, assignedClasses: 1 });

module.exports = mongoose.model('Teacher', teacherSchema);
