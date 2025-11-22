// models/Subject.js
const mongoose = require("mongoose");

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    shortName: { type: String, trim: true },
    aliases: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Normalize values to a canonical form on save to keep uniqueness predictable
subjectSchema.pre("save", function (next) {
  if (this.name) this.name = this.name.trim().toUpperCase();
  if (this.shortName) this.shortName = this.shortName.trim().toUpperCase();
  if (Array.isArray(this.aliases) && this.aliases.length > 0) {
    this.aliases = this.aliases.map((a) => (a ? a.trim().toUpperCase() : a)).filter(Boolean);
  }
  next();
});

// Ensure an index on name (global uniqueness)
subjectSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model("Subject", subjectSchema);
