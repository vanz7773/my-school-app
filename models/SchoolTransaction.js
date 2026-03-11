const mongoose = require('mongoose');

const schoolTransactionSchema = new mongoose.Schema({
    school: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'School',
        required: true
    },
    type: {
        type: String,
        enum: ['invoice', 'payment'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    dueDate: {
        type: Date
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'cancelled'],
        default: 'paid'
    },
    reference: {
        type: String
    },
    items: [{
        description: String,
        amount: Number
    }]
}, { timestamps: true });

schoolTransactionSchema.index({ school: 1, date: -1 });  // Typical dashboard view
schoolTransactionSchema.index({ school: 1, type: 1, status: 1 }); // Filtering by type/status
schoolTransactionSchema.index({ reference: 1 }); // Looking up specific transactions

module.exports = mongoose.model('SchoolTransaction', schoolTransactionSchema);
