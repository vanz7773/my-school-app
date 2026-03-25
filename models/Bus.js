const mongoose = require('mongoose');

const busSchema = new mongoose.Schema({
  name: { type: String, required: true },
  capacity: { type: Number, required: true },
  driverName: { type: String, required: true },
  driverPhone: { type: String },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Bus', busSchema);
