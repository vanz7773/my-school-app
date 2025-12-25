const mongoose = require("mongoose");

const classSchema = new mongoose.Schema(
  {
    // 📘 Academic level (e.g. BASIC 9, KG 2)
    name: {
      type: String,
      required: [true, "Class name is required"],
      trim: true,
    },

    // 🅰️ Optional stream (A, B, C…)
    stream: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    // 🏷️ Display name shown in UI (e.g. BASIC 9A)
    displayName: {
      type: String,
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

/**
 * 🔒 UNIQUE RULE (VERY IMPORTANT)
 * A class is unique by:
 *   school + name + stream
 *
 * This allows:
 *   BASIC 9
 *   BASIC 9A
 *   BASIC 9B
 *   BASIC 9C
 *
 * And prevents:
 *   Duplicate BASIC 9A
 */
classSchema.index(
  { school: 1, name: 1, stream: 1 },
  { unique: true }
);

module.exports = mongoose.model("Class", classSchema);
