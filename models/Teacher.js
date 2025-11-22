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

module.exports = mongoose.model('Teacher', teacherSchema);
