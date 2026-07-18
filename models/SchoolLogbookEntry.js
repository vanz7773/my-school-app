const mongoose = require('mongoose');

const schoolLogbookEntrySchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    activityDate: {
      type: Date,
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: [
        'General',
        'Academic',
        'Attendance',
        'Discipline',
        'Health',
        'Visitors',
        'Maintenance',
        'Finance',
        'Safety',
        'Meeting',
        'Event',
        'Other',
      ],
      default: 'General',
      index: true,
    },
    priority: {
      type: String,
      enum: ['Low', 'Normal', 'High', 'Critical'],
      default: 'Normal',
      index: true,
    },
    location: {
      type: String,
      trim: true,
      default: '',
      maxlength: 160,
    },
    peopleInvolved: [
      {
        type: String,
        trim: true,
        maxlength: 120,
      },
    ],
    actionTaken: {
      type: String,
      trim: true,
      default: '',
      maxlength: 3000,
    },
    followUpRequired: {
      type: Boolean,
      default: false,
      index: true,
    },
    followUpDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
      default: 'Open',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

schoolLogbookEntrySchema.index({
  title: 'text',
  description: 'text',
  location: 'text',
  actionTaken: 'text',
  peopleInvolved: 'text',
});
schoolLogbookEntrySchema.index({ school: 1, activityDate: -1, createdAt: -1 });
schoolLogbookEntrySchema.index({ school: 1, category: 1, activityDate: -1 });

module.exports =
  mongoose.models.SchoolLogbookEntry ||
  mongoose.model('SchoolLogbookEntry', schoolLogbookEntrySchema);
