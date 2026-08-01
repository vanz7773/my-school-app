const mongoose = require('mongoose');

const nonTeachingStaffSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: String,
      trim: true,
      default: '',
      maxlength: 100,
    },
  },
  { timestamps: true }
);

nonTeachingStaffSchema.index({ school: 1, name: 1 });
nonTeachingStaffSchema.index({ school: 1, phone: 1 });

module.exports = mongoose.model('NonTeachingStaff', nonTeachingStaffSchema);
