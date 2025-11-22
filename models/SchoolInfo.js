const mongoose = require('mongoose');

const schoolInfoSchema = new mongoose.Schema(
  {
    school: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'School', // reference the School collection
      required: true,
      unique: true // one SchoolInfo per school
    },
    address: { type: String },
    phone: { type: String },
    email: { type: String },
    logo: { type: String }, // path or URL to logo
    headTeacherName: { type: String },
    headTeacherSignature: { type: String } // path or URL to signature
  },
  { timestamps: true }
);

module.exports = mongoose.model('SchoolInfo', schoolInfoSchema);
