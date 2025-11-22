const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

// School-specific Fee Template
const feeTemplateSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  name: { type: String, required: true },
  items: [{
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    isMandatory: { type: Boolean, default: true }
  }],
  currency: { type: String, default: 'GHS' }
}, { timestamps: true });

const PaymentSchema = new mongoose.Schema({
  bill: { type: mongoose.Schema.Types.ObjectId, ref: 'TermBill', required: true },
  amount: { type: Number, required: true, min: 0 },
  method: { type: String, required: true, enum: ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Other'] },
  term: { type: String, required: true },
  academicYear: { type: String, required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  paymentDate: { type: Date, default: Date.now }
}, { timestamps: true });


// Term Bill (with school-specific fees)
const termBillSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class' // Make sure this matches your Class model name
  },
  template: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeTemplate' },
  term: { type: String, required: true },
  academicYear: { type: String, required: true },
  items: [{
    name: String,
    amount: Number,
    paid: { type: Number, default: 0 },
    balance: { type: Number, default: function() { return this.amount; } }
  }],
  totalAmount: { type: Number, required: true },
  totalPaid: { type: Number, default: 0 },
  status: { 
    type: String, 
    enum: ['Unpaid', 'Pending', 'Partial', 'Paid'], 
    default: 'Unpaid' 
  },
  isManualUpdate: { type: Boolean, default: false },
  payments: [{
    amount: { type: Number, required: true },
    method: { type: String, required: true },
    date: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  versions: [{
    items: [{
      name: String,
      amount: Number,
      paid: Number,
      balance: Number
    }],
    totalAmount: Number,
    balance: Number,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedAt: { type: Date, default: Date.now }
  }],
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true }
}, { 
  timestamps: true,
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

// Add indexes
termBillSchema.index(
  { student: 1, term: 1, academicYear: 1 },
  { 
    unique: true,
    partialFilterExpression: { isManualUpdate: { $ne: true } }
  }
);


// Parent-Student Relationship
const parentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  children: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true }
});

// Add pagination plugin
feeTemplateSchema.plugin(mongoosePaginate);

module.exports = {
  FeeTemplate: mongoose.model('FeeTemplate', feeTemplateSchema),
  TermBill: mongoose.model('TermBill', termBillSchema),
  Parent: mongoose.model('Parent', parentSchema),
  Payment: mongoose.model('Payment',PaymentSchema),
};