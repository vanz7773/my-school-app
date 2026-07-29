const mongoose = require('mongoose');

const schoolExpenseSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      default: 'General',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    expenseDate: {
      type: Date,
      required: true,
      index: true,
    },
    periodType: {
      type: String,
      enum: ['weekly', 'monthly', 'termly'],
      default: 'weekly',
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Other'],
      default: 'Cash',
    },
    vendor: {
      type: String,
      trim: true,
      default: '',
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Term',
      default: null,
      index: true,
    },
    week: {
      type: Number,
      min: 1,
      default: null,
      index: true,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

schoolExpenseSchema.index({ school: 1, expenseDate: -1 });
schoolExpenseSchema.index({ school: 1, termId: 1, week: 1 });

module.exports =
  mongoose.models.SchoolExpense ||
  mongoose.model('SchoolExpense', schoolExpenseSchema);
