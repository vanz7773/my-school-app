// models/profile.js
const mongoose = require("mongoose");

const profileSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ["student", "teacher", "admin", "parent"] },
  profilePicture: { type: String, default: null } // 🔑 Store Firebase URL
});

module.exports = mongoose.model("profile", profileSchema);
