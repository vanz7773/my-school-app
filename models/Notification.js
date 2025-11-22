// models/Notification.js
const mongoose = require('mongoose');

const VALID_TYPES = [
  'general',
  'announcement',
  'reset-request',
  'reset-approved',
  'reset-rejected',
  'attendance',
  'assignment',
  'fee',
  'agenda',
  'online-quiz',
  'exam-report',
  'report',
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
      index: true, // ⚡ index speeds up filtering
    },

    audience: {
      type: String,
      enum: VALID_AUDIENCES,
      default: 'all',
      index: true, // ⚡ often queried
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
    // DIRECT USER TARGETS (student/parent/teacher/admin)
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
      required: false,
    },

    // ------------------------------------------------------
    // SCHOOL CONTEXT
    // ------------------------------------------------------
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true, // ⚡ all queries start with school
    },

    // ------------------------------------------------------
    // OPTIONAL RESOURCE LINKING (reset requests / assignment / agenda)
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
        index: true, // ⚡ mark-all-read & isRead faster
      },
    ],
  },
  { timestamps: true }
);

/* ------------------------------------------------------
   HIGH-PERFORMANCE INDEXES
   MongoDB will optimize multi-field queries massively.
------------------------------------------------------ */

// 🔥 Fastest query path for "notifications for a user inside a school"
notificationSchema.index({ school: 1, recipientUsers: 1 });
notificationSchema.index({ school: 1, audience: 1 });
notificationSchema.index({ school: 1, recipientRoles: 1 });
notificationSchema.index({ school: 1, type: 1 });

// 🔥 Speed up "class notifications"
notificationSchema.index({ school: 1, class: 1 });

// 🔥 Speed up "readBy" + school operations
notificationSchema.index({ school: 1, readBy: 1 });

// 🔥 Reduce full-collection scans on sort
notificationSchema.index({ school: 1, createdAt: -1 });

/* ------------------------------------------------------
   EXPORT MODEL SAFELY (avoids overwrite in dev)
------------------------------------------------------ */
module.exports =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema);
