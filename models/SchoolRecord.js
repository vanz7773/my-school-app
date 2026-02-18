const mongoose = require('mongoose');

const schoolRecordSchema = new mongoose.Schema({
    school: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'School',
        required: true
    },
    className: {
        type: String, // e.g., "KG1", "Basic 7"
        required: true
    },
    level: {
        type: String,
        enum: ['KG', 'Primary', 'JHS'],
        required: true
    },
    infrastructure: {
        classrooms: { type: Number, default: 0 },
        furniture: {
            monoDesks: { type: Number, default: 0 },
            dualDesks: { type: Number, default: 0 },
            teacherTables: { type: Number, default: 0 },
            teacherChairs: { type: Number, default: 0 },
            cupboards: { type: Number, default: 0 },
            hexagonalTables: { type: Number, default: 0 },
            roundTables: { type: Number, default: 0 }
        },
        boards: {
            markerBoards: { type: Number, default: 0 },
            chalkBoards: { type: Number, default: 0 }
        }
    },
    enrolment: {
        male: { type: Number, default: 0 },
        female: { type: Number, default: 0 },
        total: { type: Number, default: 0 }
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Ensure unique record per class per school
schoolRecordSchema.index({ school: 1, className: 1 }, { unique: true });

// Pre-save to calculate total enrolment
schoolRecordSchema.pre('save', function (next) {
    if (this.enrolment) {
        this.enrolment.total = (Number(this.enrolment.male) || 0) + (Number(this.enrolment.female) || 0);
    }
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('SchoolRecord', schoolRecordSchema);
