const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  assignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
    required: true
  },
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true
  },
  fileUrl: String, // or file data
  submittedAt: {
    type: Date,
    default: Date.now
  },
  grade: String,
  feedback: String,
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  }
}, { timestamps: true });

// ⚡ Optimize querying submissions for an assignment or by a student
submissionSchema.index({ school: 1, assignment: 1 });
submissionSchema.index({ school: 1, student: 1 });
submissionSchema.index({ assignment: 1, student: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
