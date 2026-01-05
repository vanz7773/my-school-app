const mongoose = require("mongoose");

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

    // Answers are stored incrementally during the attempt
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

/* ------------------------------------------------------------------
   🔒 HARD GUARANTEE (CRITICAL)
   One and only ONE active attempt per quiz per student
   (This is what blocks fresh starts on another device)
------------------------------------------------------------------- */
QuizAttemptSchema.index(
  { quizId: 1, studentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "in-progress" },
  }
);

/* ------------------------------------------------------------------
   📊 HISTORY & ANALYTICS
------------------------------------------------------------------- */
QuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 });

/* ------------------------------------------------------------------
   ⚡ PERFORMANCE
------------------------------------------------------------------- */
QuizAttemptSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("QuizAttempt", QuizAttemptSchema);
