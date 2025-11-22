const mongoose = require('mongoose');

const QuizAttemptSchema = new mongoose.Schema({
  quizId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'QuizSession', 
    required: true 
  },
  studentId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  sessionId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  attemptNumber: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  startTime: { 
    type: Date, 
    default: Date.now 
  },
  expiresAt: { 
    type: Date, 
    required: true 
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['in-progress', 'submitted', 'expired'],
    default: 'in-progress'
  },
  answers: { 
    type: Map, 
    of: mongoose.Schema.Types.Mixed, 
    default: {} 
  }
}, { 
  timestamps: true 
});

// Compound index for efficient querying by quiz and student
QuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 });

// Index for sessionId lookups
QuizAttemptSchema.index({ sessionId: 1 });

// Index for active attempts
QuizAttemptSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('QuizAttempt', QuizAttemptSchema);