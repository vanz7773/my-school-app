// models/DeviceBinding.js
const mongoose = require('mongoose');

const deviceBindingSchema = new mongoose.Schema({
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Teacher',
    required: true,
    unique: true // 🔒 One device per teacher
  },
  deviceUUID: {
    type: String,
    required: true,
    unique: true // 🔒 Prevents multiple teachers binding the same device
  },
  boundAt: {
    type: Date,
    default: Date.now // Auto timestamp when first bound
  }
}, {
  timestamps: true // Adds createdAt + updatedAt
});

module.exports = mongoose.model('DeviceBinding', deviceBindingSchema);
