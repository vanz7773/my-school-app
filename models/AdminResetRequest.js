const mongoose = require('mongoose');

const AdminResetRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // the target user
  email: { type: String, required: true },
  role: { type: String, enum: ['teacher','parent','student','admin'], required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
  status: { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  requestedByIp: { type: String },
  requestedAt: { type: Date, default: Date.now },
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // admin who approved/rejected
  handledAt: { type: Date },
  note: { type: String }, // admin note
  result: { type: mongoose.Schema.Types.Mixed } // to store result metadata if needed
}, { timestamps: true });

module.exports = mongoose.model('AdminResetRequest', AdminResetRequestSchema);
