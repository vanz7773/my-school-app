const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

const weeklyExerciseSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  class: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  term: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', required: true },
  week: { type: Number, required: true },
  totalExercises: { type: Number, default: 0 },
  finalized: { type: Boolean, default: false },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  toJSON: { virtuals: true } // Ensures virtuals are included in API responses
});

// Add pagination plugin
weeklyExerciseSchema.plugin(mongoosePaginate);

// ✅ Correct compound index taking 'term' into account
weeklyExerciseSchema.index(
  { teacher: 1, class: 1, term: 1, week: 1 },
  { unique: true }
);

/**
 * 🧹 Pre-save hook to automatically clean up the legacy index that didn't include 'term'.
 * This prevents the E11000 duplicate key error when moving to Term 2.
 */
weeklyExerciseSchema.pre('save', async function (next) {
  try {
    const collection = this.constructor.collection;
    const indexes = await collection.indexes();

    // Find the legacy index that is missing 'term'
    const legacyIndex = indexes.find(
      (idx) => idx.name === 'teacher_1_class_1_week_1' ||
        (idx.key && idx.key.teacher === 1 && idx.key.class === 1 && idx.key.week === 1 && !idx.key.term)
    );

    if (legacyIndex) {
      console.log(`🧹 Removing legacy WeeklyExercise index: ${legacyIndex.name}`);
      await collection.dropIndex(legacyIndex.name);
    }
  } catch (err) {
    // If it fails (e.g. collection doesn't exist yet), just continue
    console.warn('⚠️ Could not check/remove legacy index:', err.message);
  }
  next();
});

module.exports = mongoose.model('WeeklyExercise', weeklyExerciseSchema);