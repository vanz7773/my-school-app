const mongoose = require('mongoose');
const Teacher = require('./Teacher'); // ensure correct path

// ----------------- Question Schema -----------------
const QuestionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  type: {
    type: String,
    enum: ['multiple-choice', 'true-false', 'short-answer', 'essay'],
    default: 'multiple-choice',
    required: true
  },
  options: [{ type: String }],
  correctAnswer: {
    type: mongoose.Schema.Types.Mixed,
    required: function () {
      return this.type !== 'essay'; // essays manually graded
    }
  },
  explanation: { type: String },
  points: { type: Number, default: 1 },
  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium'
  },
  tags: [{ type: String }]
});

// ----------------- QuizSession Schema -----------------
const QuizSessionSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  class: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },

  /**
   * Subject is optional, but if provided must be a valid ID.
   * Sessions always save subjectName for display.
   */
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: false
  },

  // Always-save plain subject name
  subjectName: { type: String, required: true, trim: true },

  title: { type: String, required: true },
  description: { type: String },
  notesText: String,

  questions: [QuestionSchema],

  timeLimit: { type: Number, default: null },
  startTime: { type: Date, default: null },
  dueDate: { type: Date, default: null },

  isPublished: { type: Boolean, default: false },
  publishedAt: { type: Date, default: null },

  fromQuestionBank: { type: Boolean, default: false },
  allowRetakes: { type: Boolean, default: false },
  maxAttempts: { type: Number, default: 1 },

  showAnswers: {
    type: String,
    enum: ['after-submission', 'after-deadline', 'never'],
    default: 'after-deadline'
  },

  shuffleQuestions: { type: Boolean, default: false },
  shuffleOptions: { type: Boolean, default: false },
  requirePassword: { type: Boolean, default: false },
  accessPassword: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ----------------- Indexes -----------------
QuizSessionSchema.index({ school: 1, class: 1 });
QuizSessionSchema.index({ school: 1, isPublished: 1, startTime: 1, dueDate: 1 });
QuizSessionSchema.index({ fromQuestionBank: 1, 'questions.tags': 1 });

// ----------------- Middleware -----------------
QuizSessionSchema.pre('save', async function (next) {
  this.updatedAt = Date.now();

  // Auto sync subjectName if subject was changed
  if (this.isModified('subject') && this.subject && mongoose.Types.ObjectId.isValid(this.subject)) {
    try {
      const Subject = mongoose.model('Subject');
      const subjectDoc = await Subject.findById(this.subject).lean();
      if (subjectDoc) {
        this.subjectName = subjectDoc.name;
      }
    } catch (err) {
      console.error('⚠️ Error auto-filling subjectName:', err.message);
    }
  }

  // subjectName must always exist
  if (!this.subjectName || !this.subjectName.trim()) {
    return next(new Error('subjectName is required and cannot be empty.'));
  }

  next();
});

// ----------------- Virtuals -----------------
QuizSessionSchema.virtual('isAvailable').get(function () {
  const now = new Date();
  if (this.startTime && now < this.startTime) return false;
  if (this.dueDate && now > this.dueDate) return false;
  return this.isPublished;
});

QuizSessionSchema.virtual('totalPoints').get(function () {
  if (!this.questions || !Array.isArray(this.questions)) return 0;
  return this.questions.reduce((sum, q) => sum + (q.points || 0), 0);
});

/**
 * Optional helper:
 * Retrieves all subjects assigned to the teacher creating this quiz.
 */
QuizSessionSchema.virtual('teacherSubjects', {
  ref: 'Teacher',
  localField: 'teacher',
  foreignField: 'user',
  justOne: true,
  options: { select: 'subjects' }
});

// ----------------- Methods -----------------
QuizSessionSchema.methods.getShuffledQuestions = function () {
  let questions = [...this.questions];
  if (this.shuffleQuestions) questions = questions.sort(() => Math.random() - 0.5);

  return questions.map(q => {
    if (q.type === 'multiple-choice' && this.shuffleOptions) {
      const options = [...q.options].sort(() => Math.random() - 0.5);
      return { ...q.toObject(), options };
    }
    return q;
  });
};

// ----------------- Statics -----------------
QuizSessionSchema.statics.findAvailableForStudent = function (studentId, classId) {
  return this.find({
    class: classId,
    isPublished: true,
    startTime: { $lte: new Date() },
    $or: [{ dueDate: null }, { dueDate: { $gte: new Date() } }]
  });
};

// ----------------- Export -----------------
module.exports = mongoose.model('QuizSession', QuizSessionSchema);
