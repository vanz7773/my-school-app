const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetRoles: [{ type: String, enum: ['admin', 'teacher', 'student', 'parent'] }],
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class' // Optional
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  },
  isDeleted: { type: Boolean, default: false },
deletedAt: Date,
deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
