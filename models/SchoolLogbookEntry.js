const mongoose = require('mongoose');

const schoolLogbookEntrySchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
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
  description: 'text',
});
schoolLogbookEntrySchema.index({ school: 1, activityDate: -1, createdAt: -1 });

module.exports =
  mongoose.models.SchoolLogbookEntry ||
  mongoose.model('SchoolLogbookEntry', schoolLogbookEntrySchema);
