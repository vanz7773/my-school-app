// models/Notification.js
const mongoose = require('mongoose');

const VALID_TYPES = [
  'general',
  'announcement',
  'reset-request',
  'reset-approved',
  'reset-rejected',
  'attendance',
  'teacher-attendance',   // ✅ ADDED
  'assignment',
  'feedingfee',
  'agenda',
  'online-quiz',
  'exam-report',
  'report-card',
];

const VALID_AUDIENCES = ['admin', 'teacher', 'student', 'parent', 'all', 'class'];

const notificationSchema = new mongoose.Schema(
  {
    // ------------------------------------------------------
    // CORE FIELDS
    // ------------------------------------------------------
    title: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },

    message: {
      type: String,
      trim: true,
      required: true,
      maxlength: 2000,
    },

    type: {
      type: String,
      enum: VALID_TYPES,
      default: 'general',
      index: true,
    },

    audience: {
      type: String,
      enum: VALID_AUDIENCES,
      default: 'all',
      index: true,
    },

    // ------------------------------------------------------
    // CLASS-SPECIFIC TARGETING
    // ------------------------------------------------------
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      index: true,
      default: null,
    },

    // ------------------------------------------------------
    // DIRECT USER TARGETS
    // ------------------------------------------------------
    recipientUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
      },
    ],

    // ------------------------------------------------------
    // ROLE-BASED TARGETS
    // ------------------------------------------------------
    recipientRoles: [
      {
        type: String,
        index: true,
      },
    ],

    // ------------------------------------------------------
    // SENDER
    // ------------------------------------------------------
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    // ------------------------------------------------------
    // SCHOOL CONTEXT
    // ------------------------------------------------------
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },

    // ------------------------------------------------------
    // OPTIONAL RESOURCE LINKING
    // ------------------------------------------------------
    relatedResource: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'resourceModel',
      index: true,
    },

    resourceModel: {
      type: String,
      enum: [
        'AdminResetRequest',
        'Assignment',
        'Attendance',
        'FeeRecord',
        'User',
        'AgendaEvent',
      ],
    },

    // ------------------------------------------------------
    // READ TRACKING
    // ------------------------------------------------------
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
      },
    ],
  },
  { timestamps: true }
);

/* ------------------------------------------------------
   HIGH-PERFORMANCE INDEXES
------------------------------------------------------ */
notificationSchema.index({ school: 1, recipientUsers: 1 });
notificationSchema.index({ school: 1, audience: 1 });
notificationSchema.index({ school: 1, recipientRoles: 1 });
notificationSchema.index({ school: 1, type: 1 });
notificationSchema.index({ school: 1, class: 1 });
notificationSchema.index({ school: 1, readBy: 1 });
notificationSchema.index({ school: 1, createdAt: -1 });

/* ------------------------------------------------------
   EXPORT MODEL SAFELY
------------------------------------------------------ */
module.exports =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema);
