const mongoose = require('mongoose');

const QuizAttemptSchema = new mongoose.Schema({
  quizId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'QuizSession', 
    required: true 
  },

  // 🔴 IMPORTANT: this MUST consistently store the Student._id
  // (not User._id) for cross-device resume to work
  studentId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true,
    index: true
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
    required: true,
    index: true
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
    default: 'in-progress',
    index: true
  },

  answers: { 
    type: Map, 
    of: mongoose.Schema.Types.Mixed, 
    default: {} 
  }
}, { 
  timestamps: true 
});

/* ------------------------------------------------------------------
   🔒 CRITICAL FIX: PREVENT MULTIPLE ACTIVE ATTEMPTS
   One (and only one) in-progress attempt per quiz per student
------------------------------------------------------------------- */
QuizAttemptSchema.index(
  { quizId: 1, studentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'in-progress' }
  }
);

// Existing compound index (kept – still useful for analytics/history)
QuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 });

// Fast lookup by sessionId
QuizAttemptSchema.index({ sessionId: 1 });

// Active / expiry queries
QuizAttemptSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('QuizAttempt', QuizAttemptSchema);
