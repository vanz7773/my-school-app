const mongoose = require('mongoose');

const payrollSettingsSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    unique: true
  },
  components: [{
    name: { type: String, required: true },
    type: { type: String, enum: ['earning', 'deduction'], required: true },
    amount: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true }
  }],
  attendancePenalties: {
    absentPenaltyAmount: { type: Number, default: 0 },
    latePenaltyAmount: { type: Number, default: 0 }
  }
}, { timestamps: true });

module.exports = mongoose.model('PayrollSettings', payrollSettingsSchema);
