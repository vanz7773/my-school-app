const mongoose = require("mongoose");

const classSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Class name is required"],
      trim: true,
    },

    teachers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User", // Subject teachers
      },
    ],

    classTeacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Single class teacher
      default: null,
    },

    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: [true, "School reference is required"],
    },

    students: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // 📄 Add this new field for class-level REPORT sheet PDF
    reportSheetPdfUrl: {
      type: String,
      default: null,
    },

    // 🗓️ Optional future expansion: store multiple reports by term
    reportSheetsByTerm: {
      type: Map,
      of: String, // key = termId, value = report PDF URL
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// 🔒 Ensure uniqueness of class name per school
classSchema.index({ name: 1, school: 1 }, { unique: true });

module.exports = mongoose.model("Class", classSchema);
