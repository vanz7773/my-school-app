const mongoose = require('mongoose');

const AUDIENCES = ['all', 'admin', 'teacher', 'student', 'parent', 'superadmin'];
const PLATFORMS = ['all', 'admin-dashboard', 'teacher-portal', 'mobile'];

const releaseNoteSeenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seenAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const releaseNoteSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    summary: {
      type: String,
      trim: true,
      maxlength: 280,
      default: '',
    },
    details: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    version: {
      type: String,
      trim: true,
      maxlength: 40,
      default: '',
    },
    audiences: {
      type: [String],
      enum: AUDIENCES,
      default: ['all'],
    },
    platforms: {
      type: [String],
      enum: PLATFORMS,
      default: ['all'],
    },
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    startsAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    endsAt: {
      type: Date,
      default: null,
      index: true,
    },
    seenBy: {
      type: [releaseNoteSeenSchema],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

releaseNoteSchema.index({ school: 1, isActive: 1, startsAt: -1 });
releaseNoteSchema.index({ audiences: 1, platforms: 1 });
releaseNoteSchema.index({ 'seenBy.user': 1 });

releaseNoteSchema.statics.audiences = AUDIENCES;
releaseNoteSchema.statics.platforms = PLATFORMS;

module.exports = mongoose.models.ReleaseNote || mongoose.model('ReleaseNote', releaseNoteSchema);
