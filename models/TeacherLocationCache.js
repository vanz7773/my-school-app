const mongoose = require('mongoose');

const teacherLocationCacheSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      required: true,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    accuracy: {
      type: Number,
      required: true,
    },
    source: {
      type: String,
      default: 'strict',
    },
    createdAt: {
      type: Date,
      default: Date.now,
      // TTL index to automatically delete records older than 14 days
      expires: 14 * 24 * 60 * 60,
    },
  },
  { timestamps: true }
);

// Compound index for fast querying per teacher per school
teacherLocationCacheSchema.index({ teacherId: 1, schoolId: 1 });

module.exports = mongoose.model('TeacherLocationCache', teacherLocationCacheSchema);
