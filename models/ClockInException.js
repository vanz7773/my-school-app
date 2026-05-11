const mongoose = require('mongoose');

const clockInExceptionSchema = new mongoose.Schema({
  teacherId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Teacher', 
    required: true, 
    index: true 
  },
  customRadius: { 
    type: Number, 
    required: true 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { timestamps: true });

module.exports = mongoose.model('ClockInException', clockInExceptionSchema);
