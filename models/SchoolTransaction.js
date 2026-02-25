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
    }
}, { timestamps: true });

module.exports = mongoose.model('SchoolTransaction', schoolTransactionSchema);
