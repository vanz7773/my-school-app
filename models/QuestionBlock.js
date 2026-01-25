const mongoose = require("mongoose");

const QuestionBlockSchema = new mongoose.Schema(
  {
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuestionSource",
      required: true,
      index: true,
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

    section: {
      type: String,
      enum: ["A", "B", "C", "D", "E"],
      required: true,
      index: true,
    },

    title: {
      type: String,
      trim: true,
      // e.g. "SECTION E – CLOZE TEST"
    },

    instruction: {
      type: String,
      required: true,
    },

    stimulus: {
      type: {
        type: String,
        enum: ["passage", "diagram"],
      },

      content: {
        type: String, // passage text
      },

      imageUrl: {
        type: String, // diagram / figure
      },

      caption: {
        type: String, // e.g. "Figure 2"
      },
    },

    order: {
      type: Number, // order of appearance in the paper
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

// Helpful compound index
QuestionBlockSchema.index({
  sourceId: 1,
  paper: 1,
  section: 1,
  order: 1,
});

module.exports = mongoose.model("QuestionBlock", QuestionBlockSchema);
