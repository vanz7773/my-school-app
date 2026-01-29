const mongoose = require('mongoose');

// ============================================================================
// CLOZE ITEM SCHEMA (FOR SECTION-LEVEL CLOZE)
// ============================================================================
const ClozeItemSchema = new mongoose.Schema(
  {
    number: {
      type: Number,
      required: true,
    },
    options: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 2,
        message: 'Each cloze item must have at least 2 options',
      },
    },
    correctAnswer: {
      type: String,
      required: true,
      trim: true,
    },
    points: {
      type: Number,
      default: 1,
    },
  },
  { _id: false }
);

// ============================================================================
// QUESTION SCHEMA (STANDARD QUESTIONS ONLY)
// ============================================================================
const QuestionSchema = new mongoose.Schema({
  questionText: {
    type: String,
    required: true,
    trim: true,
  },

  type: {
    type: String,
    enum: ['multiple-choice', 'true-false', 'short-answer', 'essay'],
    default: 'multiple-choice',
    required: true,
  },

  options: [{ type: String }],

  correctAnswer: {
    type: mongoose.Schema.Types.Mixed,
    required: function () {
      return !['essay'].includes(this.type);
    },
  },

  explanation: { type: String },

  points: { type: Number, default: 1 },

  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium',
  },

  tags: [{ type: String }],
});

// ============================================================================
// QUIZ SECTION SCHEMA (STANDARD + CLOZE)
// ============================================================================
const QuizSectionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['standard', 'cloze'],
    required: true,
  },

  title: {
    type: String,
    default: null,
    trim: true,
  },

  instruction: {
    type: String,
    required: true,
    trim: true,
  },

  // STANDARD
  questions: {
    type: [QuestionSchema],
    default: undefined,
  },

  // CLOZE
  passage: {
    type: String,
    default: undefined,
  },

  items: {
    type: [ClozeItemSchema],
    default: undefined,
  },
});

// ---------------------------------------------------------------------------
// 🧩 SAFE NORMALIZATION (NO THROWING, READ-SAFE)
// ---------------------------------------------------------------------------
QuizSectionSchema.pre('validate', function (next) {
  // Legacy support: if type missing but questions exist → standard
  if (!this.type && Array.isArray(this.questions)) {
    this.type = 'standard';
  }

  // ❗ DO NOT throw errors here
  // Strict validation belongs in controllers (create / publish)

  next();
});

// ============================================================================
// QUIZ SESSION SCHEMA
// ============================================================================
const QuizSessionSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },

  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true,
  },

  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: false,
  },

  subjectName: {
    type: String,
    required: true,
    trim: true,
  },

  title: {
    type: String,
    required: true,
  },

  description: String,
  notesText: String,

  // BACKWARD COMPATIBILITY
  questions: {
    type: [QuestionSchema],
    default: undefined,
  },

  // SECTION-BASED QUIZ
  sections: {
    type: [QuizSectionSchema],
    default: undefined,
  },

  timeLimit: { type: Number, default: null },
  startTime: { type: Date, default: null },
  dueDate: { type: Date, default: null },

  isPublished: { type: Boolean, default: false },
  publishedAt: { type: Date, default: null },

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
QuizSessionSchema.index({ 'sections.type': 1 });

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
  let total = 0;

  if (Array.isArray(this.sections)) {
    this.sections.forEach((section) => {
      if (section.type === 'standard') {
        section.questions?.forEach((q) => {
          total += q.points || 0;
        });
      }

      if (section.type === 'cloze') {
        section.items?.forEach((item) => {
          total += item.points || 1;
        });
      }
    });
    return total;
  }

  this.questions?.forEach((q) => {
    total += q.points || 0;
  });

  return total;
});

// ============================================================================
// EXPORT
// ============================================================================
module.exports = mongoose.model('QuizSession', QuizSessionSchema);
