const mongoose = require('mongoose');

const termSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  },
  academicYear: {
    type: String,
    required: true,
    validate: {
      validator: function (v) {
        // Must be like "2025-2026"
        return /^\d{4}-\d{4}$/.test(v) &&
          parseInt(v.split('-')[1]) === parseInt(v.split('-')[0]) + 1;
      },
      message: props => `${props.value} is not a valid academic year format (e.g., 2025-2026)`
    }
  },
  term: {
    type: String,
    required: true,
    enum: ['Term 1', 'Term 2', 'Term 3']
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true,
    validate: {
      validator: function (v) {
        return v > this.startDate;
      },
      message: 'End date must be after start date'
    }
  },

  // ✅ Added for weekly attendance tracking
  weekStartDate: {
    type: Date,
    required: true
  },
  weekNumber: {
    type: Number,
    required: true,
    min: 1
  },
  weeks: {
    type: Number,
    required: true
  }

}, { timestamps: true });

// ✅ Unique constraint to avoid duplicate term entries
termSchema.index({ school: 1, academicYear: 1, term: 1 }, { unique: true });

// ✅ Safe export: prevents OverwriteModelError
module.exports = mongoose.models.Term || mongoose.model('Term', termSchema);
