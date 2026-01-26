const mongoose = require('mongoose');
const Teacher = require('./Teacher'); // ensure correct path

// ============================================================================
// CLOZE BLANK SCHEMA (USED UNDER MULTIPLE-CHOICE)
// ============================================================================
const ClozeBlankSchema = new mongoose.Schema(
  {
    blankNumber: {
      type: Number,
      required: true, // e.g. 21, 22, 23
    },
    options: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 2,
        message: 'Each blank must have at least 2 options',
      },
    },
    correctAnswer: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

// ============================================================================
// QUESTION SCHEMA (CLOZE = MULTIPLE-CHOICE + BLANKS)
// ============================================================================
const QuestionSchema = new mongoose.Schema({
  questionText: {
    type: String,
    required: true,
    trim: true,
  },

  type: {
    type: String,
    enum: [
      'multiple-choice',
      'true-false',
      'short-answer',
      'essay',
    ],
    default: 'multiple-choice',
    required: true,
  },

  /**
   * Standard MCQ options
   * (ignored when blanks are present)
   */
  options: [{ type: String }],

  /**
   * Used by:
   * - MCQ (non-cloze)
   * - True/False
   * - Short Answer
   *
   * ❌ NOT used for Cloze (answers live in blanks)
   */
  correctAnswer: {
    type: mongoose.Schema.Types.Mixed,
    required: function () {
      return !['essay'].includes(this.type) && !this.blanks?.length;
    },
  },

  /**
   * Cloze blanks
   * Only valid when type === 'multiple-choice'
   */
  blanks: {
    type: [ClozeBlankSchema],
    default: undefined,
    validate: {
      validator: function (v) {
        // If blanks exist, must be MCQ
        if (Array.isArray(v) && v.length > 0) {
          return this.type === 'multiple-choice';
        }
        return true;
      },
      message: 'Cloze blanks are only allowed for multiple-choice questions',
    },
  },

  explanation: { type: String },

  /**
   * For cloze:
   * points PER BLANK
   */
  points: { type: Number, default: 1 },

  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium',
  },

  tags: [{ type: String }],
});

// ============================================================================
// QUIZ SECTION SCHEMA
// ============================================================================
const QuizSectionSchema = new mongoose.Schema({
  name: {
    type: String,
    default: null,
    trim: true,
  },
  instruction: {
    type: String,
    required: true,
    trim: true,
  },
  questions: {
    type: [QuestionSchema],
    required: true,
  },
});

// ============================================================================
// QUIZ SESSION SCHEMA
// ============================================================================
const QuizSessionSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  class: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },

  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: false,
  },

  subjectName: { type: String, required: true, trim: true },

  title: { type: String, required: true },
  description: { type: String },
  notesText: String,

  // BACKWARD COMPATIBILITY
  questions: [QuestionSchema],

  // SECTION-BASED EXAMS
  sections: [QuizSectionSchema],

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
    default: 'after-deadline',
  },

  shuffleQuestions: { type: Boolean, default: false },
  shuffleOptions: { type: Boolean, default: false },

  requirePassword: { type: Boolean, default: false },
  accessPassword: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ============================================================================
// INDEXES
// ============================================================================
QuizSessionSchema.index({ school: 1, class: 1 });
QuizSessionSchema.index({ school: 1, isPublished: 1, startTime: 1, dueDate: 1 });
QuizSessionSchema.index({ fromQuestionBank: 1, 'questions.tags': 1 });
QuizSessionSchema.index({ 'sections.questions.tags': 1 });

// ============================================================================
// MIDDLEWARE
// ============================================================================
QuizSessionSchema.pre('save', async function (next) {
  this.updatedAt = Date.now();

  if (
    this.isModified('subject') &&
    this.subject &&
    mongoose.Types.ObjectId.isValid(this.subject)
  ) {
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

  if (!this.subjectName || !this.subjectName.trim()) {
    return next(new Error('subjectName is required and cannot be empty.'));
  }

  next();
});

// ============================================================================
// VIRTUALS
// ============================================================================
QuizSessionSchema.virtual('isAvailable').get(function () {
  const now = new Date();
  if (this.startTime && now < this.startTime) return false;
  if (this.dueDate && now > this.dueDate) return false;
  return this.isPublished;
});

QuizSessionSchema.virtual('totalPoints').get(function () {
  const sumQuestions = (questions = []) =>
    questions.reduce((sum, q) => {
      // Cloze = multiple blanks
      if (q.type === 'multiple-choice' && Array.isArray(q.blanks) && q.blanks.length) {
        return sum + q.blanks.length * (q.points || 1);
      }
      return sum + (q.points || 0);
    }, 0);

  if (this.sections && this.sections.length) {
    return this.sections.reduce(
      (total, section) => total + sumQuestions(section.questions),
      0
    );
  }

  return sumQuestions(this.questions);
});

// ============================================================================
// METHODS
// ============================================================================
QuizSessionSchema.methods.getShuffledQuestions = function () {
  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

  const shuffleQuestion = (q) => {
    if (!this.shuffleOptions) return q;

    // Normal MCQ
    if (q.type === 'multiple-choice' && !q.blanks?.length) {
      return { ...q.toObject(), options: shuffle([...q.options]) };
    }

    // Cloze MCQ
    if (q.type === 'multiple-choice' && Array.isArray(q.blanks)) {
      const blanks = q.blanks.map((b) => ({
        ...b,
        options: shuffle([...b.options]),
      }));
      return { ...q.toObject(), blanks };
    }

    return q;
  };

  // SECTION-BASED
  if (this.sections && this.sections.length) {
    return this.sections.map((section) => {
      let questions = [...section.questions];
      if (this.shuffleQuestions) questions = shuffle(questions);

      return {
        ...section.toObject(),
        questions: questions.map(shuffleQuestion),
      };
    });
  }

  // FLAT
  let questions = [...this.questions];
  if (this.shuffleQuestions) questions = shuffle(questions);
  return questions.map(shuffleQuestion);
};

// ============================================================================
// STATICS
// ============================================================================
QuizSessionSchema.statics.findAvailableForStudent = function (studentId, classId) {
  return this.find({
    class: classId,
    isPublished: true,
    startTime: { $lte: new Date() },
    $or: [{ dueDate: null }, { dueDate: { $gte: new Date() } }],
  });
};

// ============================================================================
// EXPORT
// ============================================================================
module.exports = mongoose.model('QuizSession', QuizSessionSchema);
