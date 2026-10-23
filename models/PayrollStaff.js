const mongoose = require('mongoose');

// Payroll-only employees do not have login accounts or teacher permissions.
const schema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, required: true, trim: true },
  jobTitle: { type: String, trim: true, maxlength: 100 }
}, { timestamps: true });
module.exports = mongoose.model('PayrollStaff', schema);
