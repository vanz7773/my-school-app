// models/PushToken.js
const mongoose = require("mongoose");

const PushTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  deviceInfo: {
    type: Object,
    default: {},
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports =
  mongoose.models.PushToken ||
  mongoose.model("PushToken", PushTokenSchema);
