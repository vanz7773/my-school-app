const mongoose = require('mongoose');

// -----------------------------
// 🧩 QuestionResult Schema
// -----------------------------
const QuestionResultSchema = new mongoose.Schema({
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz.questions',
    required: true,
  },

  questionText: {
    type: String,
    required: true,
  },

  questionType: {
    type: String,
    enum: ['multiple-choice', 'true-false', 'short-answer', 'essay'],
    required: true,
  },

  selectedAnswer: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  correctAnswer: {
    type: mongoose.Schema.Types.Mixed,
    required: function () {
      const type = (this.questionType || '').toLowerCase();
      return type === 'multiple-choice' || type === 'true-false';
    },
    default: undefined,
  },

  explanation: {
    type: String,
    default: null,
  },

  isCorrect: {
    type: Boolean,
    required: function () {
      const type = (this.questionType || '').toLowerCase();
      return type === 'multiple-choice' || type === 'true-false';
    },
    default: null,
  },

  points: {
    type: Number,
    default: function () {
      const type = (this.questionType || '').toLowerCase();
      // ✅ Objective = 1 point, Manual = up to 5 points
      return type === 'multiple-choice' || type === 'true-false' ? 1 : 5;
    },
    min: 0,
  },

  earnedPoints: {
    type: Number,
    default: null, // null means “not graded yet”
  },

  manualReviewRequired: {
    type: Boolean,
    default: function () {
      const type = (this.questionType || '').toLowerCase();
      return type === 'essay' || type === 'short-answer';
    },
  },

  feedback: { type: String, default: '' },

  timeSpent: {
    type: Number,
    default: 0,
  },
});

// -----------------------------
// ✅ Dynamic validation middleware for flexible point ranges
// -----------------------------
QuestionResultSchema.pre('validate', function (next) {
  const type = (this.questionType || '').toLowerCase();

  // Essays & short answers: must be 0–5
  if (type === 'essay' || type === 'short-answer') {
    if (typeof this.points !== 'number' || isNaN(this.points)) this.points = 5;
    if (this.points > 5) this.points = 5;
    if (this.points < 0) this.points = 0;
  }
  // Objective questions (MCQ / True-False): must be 0–1
  else {
    if (typeof this.points !== 'number' || this.points < 0) this.points = 1;
    if (this.points > 1) this.points = 1;
    if (this.points < 0) this.points = 0;
  }

  next();
});

// -----------------------------
// 🧩 QuizResult Schema
// -----------------------------
const QuizResultSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },

  quizId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'QuizSession',
    required: true,
  },

  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'QuizSession',
  },

  answers: [QuestionResultSchema],

  score: { type: Number, default: null },
  totalPoints: { type: Number, required: true },
  percentage: { type: Number, default: null },
  timeSpent: { type: Number, default: 0 },
  startTime: { type: Date, required: true },
  submittedAt: { type: Date, default: Date.now },
  attemptNumber: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['in-progress', 'submitted', 'graded', 'needs-review'],
    default: 'submitted',
  },
  teacherFeedback: { type: String, default: null },
  autoGraded: { type: Boolean, default: true },
});

// -----------------------------
// 🧠 Indexes
// -----------------------------
QuizResultSchema.index({ school: 1, quizId: 1 });
QuizResultSchema.index({ school: 1, studentId: 1 });
QuizResultSchema.index({ quizId: 1, studentId: 1 });
QuizResultSchema.index({ submittedAt: -1 });
QuizResultSchema.index(
  { school: 1, studentId: 1, quizId: 1, attemptNumber: 1 },
  { unique: true }
);

// -----------------------------
// 🧩 Virtuals
// -----------------------------
QuizResultSchema.virtual('timeSpentFormatted').get(function () {
  const minutes = Math.floor(this.timeSpent / 60);
  const seconds = this.timeSpent % 60;
  return `${minutes}m ${seconds}s`;
});

QuizResultSchema.virtual('submittedDate').get(function () {
  return this.submittedAt ? this.submittedAt.toLocaleDateString() : null;
});

// -----------------------------
// 📊 Statics
// -----------------------------
QuizResultSchema.statics.getBestAttempt = function (quizId, studentId) {
  return this.findOne({ quizId, studentId }).sort({ percentage: -1 }).limit(1);
};

QuizResultSchema.statics.getQuizStats = function (quizId) {
  return this.aggregate([
    { $match: { quizId: mongoose.Types.ObjectId(quizId) } },
    {
      $group: {
        _id: '$quizId',
        averageScore: { $avg: '$percentage' },
        highScore: { $max: '$percentage' },
        lowScore: { $min: '$percentage' },
        totalAttempts: { $sum: 1 },
        totalStudents: { $addToSet: '$studentId' },
      },
    },
    {
      $project: {
        averageScore: { $round: ['$averageScore', 2] },
        highScore: { $round: ['$highScore', 2] },
        lowScore: { $round: ['$lowScore', 2] },
        totalAttempts: 1,
        totalStudents: { $size: '$totalStudents' },
      },
    },
  ]);
};

// -----------------------------
// 🧮 Instance Methods
// -----------------------------
QuizResultSchema.methods.calculateGrade = function () {
  if (this.percentage == null) return 'Pending';
  if (this.percentage >= 90) return 'A';
  if (this.percentage >= 80) return 'B';
  if (this.percentage >= 70) return 'C';
  if (this.percentage >= 60) return 'D';
  return 'F';
};

// -----------------------------
// ⚙️ Middleware
// -----------------------------
QuizResultSchema.pre('save', function (next) {
  if (this.isNew && !this.submittedAt) {
    this.submittedAt = new Date();
  }

  if (Array.isArray(this.answers)) {
    this.answers = this.answers.map((a) => {
      const type = (a.questionType || '').toLowerCase();

      if (type === 'essay' || type === 'short-answer') {
        // ✅ Ensure points always between 0–5
        if (typeof a.points !== 'number' || isNaN(a.points)) a.points = 5;
        else a.points = Math.max(0, Math.min(5, Math.round(a.points)));

        if (a.earnedPoints === undefined || a.earnedPoints === null) a.earnedPoints = null;
        if (a.feedback === undefined || a.feedback === null) a.feedback = '';
        a.isCorrect = null;
        a.correctAnswer = undefined;
        a.manualReviewRequired = true;
      } else {
        // Objective question defaults (0–1)
        if (a.points === undefined || a.points === null) a.points = 1;
        if (a.earnedPoints === undefined)
          a.earnedPoints = a.isCorrect ? (a.points || 1) : 0;
      }
      return a;
    });
  }

  const needsManualReview = this.answers?.some((a) => a.manualReviewRequired === true);

  if (needsManualReview) {
    this.status = 'needs-review';
    this.autoGraded = false;
    if (this.score === undefined || this.score === 0) this.score = null;
    if (this.percentage === undefined || this.percentage === 0) this.percentage = null;
  }

  next();
});

// -----------------------------
// ✅ Model Export
// -----------------------------
module.exports = mongoose.model('QuizResult', QuizResultSchema);
