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

module.exports = mongoose.model('WeeklyExercise', weeklyExerciseSchema);