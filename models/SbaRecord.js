const mongoose = require("mongoose");

const sbaRecordSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
    },
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    records: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Student",
          required: true,
        },
        studentUser: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        classWork: {
          type: Number,
          default: 0,
          min: 0,
        },
        classTest1: {
          type: Number,
          default: 0,
          min: 0,
        },
        classTest2: {
          type: Number,
          default: 0,
          min: 0,
        },
        projectWork: {
          type: Number,
          default: 0,
          min: 0,
        },
        exams: {
          type: Number,
          default: 0,
          min: 0,
        },
        total: {
          type: Number,
          default: 0,
          min: 0,
        },
        grade: {
          type: String,
          default: "",
        },
        remarks: {
          type: String,
          default: "",
        },
        conduct: {
          type: String,
          default: "",
        },
        interest: {
          type: String,
          default: "",
        },
        teacherRemarks: {
          type: String,
          default: "",
        },
        promotedTo: {
          type: String,
          default: "",
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Ensure there is only one record per subject per term for a given class
sbaRecordSchema.index(
  { school: 1, class: 1, term: 1, subject: 1 },
  { unique: true }
);

module.exports = mongoose.model("SbaRecord", sbaRecordSchema);
