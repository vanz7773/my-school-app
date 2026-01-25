const mongoose = require("mongoose");

const ExamQuestionSchema = new mongoose.Schema(
  {
    blockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuestionBlock",
      required: true,
      index: true,
    },

    paper: {
      type: Number,
      enum: [1, 2],
      required: true,
    },

    section: {
      type: String,
      enum: ["A", "B", "C", "D", "E"],
      required: true,
    },

    questionNumber: {
      type: Number, // e.g. 31
    },

    type: {
      type: String,
      enum: [
        "mcq",
        "cloze",
        "short-answer",
        "essay",
        "structured",
        "practical",
      ],
      required: true,
    },

    questionText: {
      type: String,
      required: true,
    },

    // For MCQ / Cloze
    options: {
      type: [String], // A–D
      default: [],
    },

    // For MCQ / Cloze
    correctAnswer: {
      type: mongoose.Schema.Types.Mixed, // "A", ["A","C"], text, etc.
    },

    // For Paper 2 (essay, structured)
    markingGuide: {
      type: String,
    },

    // For structured questions (a, b, c)
    subQuestions: [
      {
        label: String, // a, b, i, ii
        text: String,
        marks: Number,
      },
    ],

    marks: {
      type: Number,
      default: 1,
    },

    status: {
      type: String,
      enum: ["draft", "approved", "archived"],
      default: "draft",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ExamQuestion", ExamQuestionSchema);
