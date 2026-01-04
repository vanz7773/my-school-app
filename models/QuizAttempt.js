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

  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
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
  },

  // Track saves for debugging
  saveCount: {
    type: Number,
    default: 0
  },

  // Track resumes for debugging
  resumeCount: {
    type: Number,
    default: 0
  },

  // Device info for multi-device support
  deviceInfo: {
    platform: String,
    osVersion: String,
    appVersion: String,
    deviceId: String
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

// School-based queries for multi-tenancy
QuizAttemptSchema.index({ school: 1, status: 1, expiresAt: 1 });

// ------------------------------------------------------------------
// INSTANCE METHODS
// ------------------------------------------------------------------

/**
 * Check if attempt is expired
 */
QuizAttemptSchema.methods.isExpired = function() {
  return this.expiresAt < new Date();
};

/**
 * Get time remaining in seconds
 */
QuizAttemptSchema.methods.getTimeRemaining = function() {
  const now = new Date();
  if (this.expiresAt <= now) return 0;
  return Math.floor((this.expiresAt - now) / 1000);
};

/**
 * Update last activity time
 */
QuizAttemptSchema.methods.touch = function() {
  this.lastActivity = new Date();
  return this.save();
};

/**
 * Submit the attempt
 */
QuizAttemptSchema.methods.submit = async function(answers = null) {
  if (answers) {
    this.answers = answers;
  }
  this.status = 'submitted';
  this.completedAt = new Date();
  return this.save();
};

/**
 * Mark as expired (for auto-submit)
 */
QuizAttemptSchema.methods.markAsExpired = async function() {
  this.status = 'expired';
  this.completedAt = new Date();
  return this.save();
};

// ------------------------------------------------------------------
// STATIC METHODS (Atomic Operations - No Transactions Needed)
// ------------------------------------------------------------------

/**
 * Find or create active attempt (Atomic Operation)
 * This is the core method for preventing duplicate attempts
 */
QuizAttemptSchema.statics.findOrCreateActiveAttempt = async function({
  quizId,
  studentId,
  school,
  timeLimit,
  deviceInfo = null
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (timeLimit * 1000));
  const sessionId = new mongoose.Types.ObjectId().toString();

  try {
    // Try to find existing active attempt first
    let attempt = await this.findOne({
      quizId,
      studentId,
      school,
      status: 'in-progress',
      expiresAt: { $gt: now }
    });

    if (attempt) {
      // Update last activity and resume count
      attempt.lastActivity = now;
      attempt.resumeCount += 1;
      if (deviceInfo) attempt.deviceInfo = deviceInfo;
      await attempt.save();
      return { attempt, created: false };
    }

    // Check for expired attempt that needs cleanup
    const expiredAttempt = await this.findOne({
      quizId,
      studentId,
      school,
      status: 'in-progress',
      expiresAt: { $lte: now }
    });

    if (expiredAttempt) {
      expiredAttempt.status = 'expired';
      expiredAttempt.completedAt = now;
      await expiredAttempt.save();
    }

    // Create new attempt with unique constraint enforcement
    // This will fail if another attempt was created concurrently
    try {
      attempt = await this.create({
        quizId,
        studentId,
        school,
        sessionId,
        startTime: now,
        expiresAt,
        attemptNumber: 1, // You might want to calculate this based on previous attempts
        status: 'in-progress',
        lastActivity: now,
        deviceInfo,
        answers: {}
      });
      return { attempt, created: true };
    } catch (createError) {
      // If unique constraint violation (another process created attempt), find it
      if (createError.code === 11000 || createError.message.includes('duplicate')) {
        attempt = await this.findOne({
          quizId,
          studentId,
          school,
          status: 'in-progress'
        });
        if (attempt) {
          attempt.lastActivity = now;
          attempt.resumeCount += 1;
          await attempt.save();
          return { attempt, created: false };
        }
      }
      throw createError;
    }
  } catch (error) {
    console.error('Error in findOrCreateActiveAttempt:', error);
    throw error;
  }
};

/**
 * Update answers atomically
 */
QuizAttemptSchema.statics.updateAnswers = async function(
  quizId,
  studentId,
  school,
  answers
) {
  const now = new Date();
  
  return this.findOneAndUpdate(
    {
      quizId,
      studentId,
      school,
      status: 'in-progress',
      expiresAt: { $gt: now }
    },
    {
      $set: { 
        answers,
        lastActivity: now
      },
      $inc: { saveCount: 1 }
    },
    {
      new: true,
      runValidators: true
    }
  );
};

/**
 * Get active attempt with time remaining
 */
QuizAttemptSchema.statics.getActiveAttempt = async function(
  quizId,
  studentId,
  school
) {
  const now = new Date();
  
  const attempt = await this.findOne({
    quizId,
    studentId,
    school,
    status: 'in-progress',
    expiresAt: { $gt: now }
  });

  if (!attempt) return null;

  // Calculate time remaining
  const timeRemaining = attempt.getTimeRemaining();
  
  return {
    attempt,
    timeRemaining,
    expired: timeRemaining <= 0
  };
};

/**
 * Auto-expire old attempts (Background job)
 */
QuizAttemptSchema.statics.expireOldAttempts = async function(batchSize = 100) {
  const now = new Date();
  
  const result = await this.updateMany(
    {
      status: 'in-progress',
      expiresAt: { $lte: now }
    },
    {
      $set: {
        status: 'expired',
        completedAt: now
      }
    }
  ).limit(batchSize);

  return result.modifiedCount;
};

/**
 * Check if student has completed quiz (any status except in-progress)
 */
QuizAttemptSchema.statics.hasCompletedQuiz = async function(
  quizId,
  studentId,
  school
) {
  const count = await this.countDocuments({
    quizId,
    studentId,
    school,
    status: { $in: ['submitted', 'expired'] }
  });
  
  return count > 0;
};

/**
 * Get attempt history for student
 */
QuizAttemptSchema.statics.getAttemptHistory = async function(
  studentId,
  school,
  limit = 10
) {
  return this.find({
    studentId,
    school,
    status: { $in: ['submitted', 'expired'] }
  })
  .populate('quizId', 'title subjectName')
  .sort({ completedAt: -1 })
  .limit(limit)
  .lean();
};

// ------------------------------------------------------------------
// PRE-SAVE MIDDLEWARE
// ------------------------------------------------------------------

QuizAttemptSchema.pre('save', function(next) {
  const now = new Date();
  
  // Auto-update lastActivity on any save
  if (this.isModified()) {
    this.lastActivity = now;
  }
  
  // Auto-mark as expired if expiresAt is in the past
  if (this.status === 'in-progress' && this.expiresAt < now) {
    this.status = 'expired';
    this.completedAt = now;
  }
  
  next();
});

// ------------------------------------------------------------------
// VIRTUAL FIELDS
// ------------------------------------------------------------------

QuizAttemptSchema.virtual('timeRemaining').get(function() {
  return this.getTimeRemaining();
});

QuizAttemptSchema.virtual('isActive').get(function() {
  return this.status === 'in-progress' && this.expiresAt > new Date();
});

QuizAttemptSchema.virtual('durationMinutes').get(function() {
  if (!this.completedAt) return null;
  const durationMs = this.completedAt - this.startTime;
  return Math.floor(durationMs / (1000 * 60));
});

// ------------------------------------------------------------------
// TO JSON OPTIONS
// ------------------------------------------------------------------

QuizAttemptSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    // Convert Map to plain object for JSON
    if (ret.answers instanceof Map) {
      ret.answers = Object.fromEntries(ret.answers);
    }
    return ret;
  }
});

QuizAttemptSchema.set('toObject', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('QuizAttempt', QuizAttemptSchema);