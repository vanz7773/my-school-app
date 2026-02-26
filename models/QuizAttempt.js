const mongoose = require("mongoose");

// ============================================================================
// QUIZ ATTEMPT SCHEMA
// ============================================================================
const QuizAttemptSchema = new mongoose.Schema(
  {
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuizSession",
      required: true,
      index: true,
    },

    // 🔐 SOURCE OF TRUTH
    // ALWAYS store Student._id (never User._id)
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // 🏫 REQUIRED — fixes cross-device resume
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    // Server-issued session identifier
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    attemptNumber: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },

    startTime: {
      type: Date,
      required: true,
      default: Date.now,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    lastActivity: {
      type: Date,
      default: Date.now,
      index: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ["in-progress", "submitted", "expired"],
      default: "in-progress",
      index: true,
    },

    /**
     * ANSWERS STORAGE (AUTHORITATIVE)
     *
     * Key formats:
     *
     * 1️⃣ Normal Multiple Choice / True-False / Short Answer
     *    questionId -> value
     *
     *    Example:
     *    answers["64fa...a1"] = "B"
     *
     * 2️⃣ Cloze (MCQ with blanks)
     *    questionId:blankNumber -> value
     *
     *    Example:
     *    answers["64fa...a2:21"] = "feed"
     *    answers["64fa...a2:22"] = "diligence"
     *
     * RULE:
     * - If a question has blanks, NEVER store answer on questionId alone
     */
    answers: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================================
// 🔒 HARD GUARANTEE (CRITICAL)
// One and only ONE active attempt per quiz per student
// ============================================================================
QuizAttemptSchema.index(
  { quizId: 1, studentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "in-progress" },
  }
);

// ============================================================================
// 📊 HISTORY & ANALYTICS
// ============================================================================
QuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 });

// ============================================================================
// ⚡ PERFORMANCE
// ============================================================================
QuizAttemptSchema.index({ status: 1, expiresAt: 1 });
QuizAttemptSchema.index({ school: 1, studentId: 1 }); // ⚡ Optimize fetching a student's attempt history
QuizAttemptSchema.index({ school: 1, quizId: 1 });    // ⚡ Optimize fetching all attempts for a specific quiz

// ============================================================================
// 🧠 INSTANCE HELPERS (STRONGLY RECOMMENDED)
// ============================================================================
/**
 * Build a safe answer key
 * - Normal question → questionId
 * - Cloze blank → questionId:blankNumber
 */
QuizAttemptSchema.methods.buildAnswerKey = function (
  questionId,
  blankNumber = null
) {
  return blankNumber !== null
    ? `${questionId}:${blankNumber}`
    : `${questionId}`;
};

/**
 * Save or update an answer safely
 */
QuizAttemptSchema.methods.setAnswer = function (
  questionId,
  value,
  blankNumber = null
) {
  const key = this.buildAnswerKey(questionId, blankNumber);
  this.answers.set(key, value);
  this.lastActivity = new Date();
};

/**
 * Read an answer safely
 */
QuizAttemptSchema.methods.getAnswer = function (
  questionId,
  blankNumber = null
) {
  const key = this.buildAnswerKey(questionId, blankNumber);
  return this.answers.get(key);
};

/**
 * Remove an answer (useful when changing options)
 */
QuizAttemptSchema.methods.clearAnswer = function (
  questionId,
  blankNumber = null
) {
  const key = this.buildAnswerKey(questionId, blankNumber);
  this.answers.delete(key);
  this.lastActivity = new Date();
};

// ============================================================================
// EXPORT
// ============================================================================
module.exports = mongoose.model("QuizAttempt", QuizAttemptSchema);
