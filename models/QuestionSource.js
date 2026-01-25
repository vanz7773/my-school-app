const mongoose = require("mongoose");

const QuestionSourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
      index: true,
    },

    paper: {
      type: Number,
      enum: [1, 2],
      required: true,
    },

    year: {
      type: Number,
    },

    sourceType: {
      type: String,
      enum: ["bece", "mock", "publisher", "teacher"],
      required: true,
    },

    pdfUrl: {
      type: String,
      required: true,
    },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["draft", "processed", "archived"],
      default: "draft",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate uploads of same source
QuestionSourceSchema.index(
  { title: 1, subjectId: 1, paper: 1, year: 1 },
  { unique: true }
);

module.exports = mongoose.model("QuestionSource", QuestionSourceSchema);
