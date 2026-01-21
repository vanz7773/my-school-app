// models/SbaTemplate.js
const mongoose = require("mongoose");

const sbaTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true },       
  url: { type: String, required: true },       
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  uploadedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("SbaTemplate", sbaTemplateSchema);
