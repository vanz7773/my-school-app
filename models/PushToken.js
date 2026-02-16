// models/PushToken.js
const mongoose = require("mongoose");

const PushTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },

  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "School",
    required: true,
    index: true,
  },

  token: {
    type: String,
    required: true,
    unique: true,
  },

  platform: {
    type: String,
    enum: ["ios", "android", "web"],
    required: true,
    index: true,
  },

  deviceInfo: {
    type: Object,
    default: {},
  },

  // For Web Push
  subscription: {
    endpoint: String,
    expirationTime: Number,
    keys: {
      p256dh: String,
      auth: String
    }
  },

  disabled: {
    type: Boolean,
    default: false,
    index: true,
  },

  lastSeen: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: true });

module.exports =
  mongoose.models.PushToken ||
  mongoose.model("PushToken", PushTokenSchema);
