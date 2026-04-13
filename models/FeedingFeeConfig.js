const mongoose = require('mongoose');

// --------------------- Schema Definition ---------------------
const feedingFeeConfigSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },

  // Class-based fee bands (modern structure)
  classFeeBands: {
    type: Map,
    of: {
      className: { type: String },
      level: { type: String },
      amount: { type: Number, default: 0 },
    },
    default: {},
  },

  currency: { type: String, default: 'GHS' },
  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

// --------------------- Utility Functions ---------------------
const normalizeClassName = (s) => (s || '').toString().toLowerCase().trim();

const normalizeClassFeeBands = (bands = {}) => {
  if (bands instanceof Map) {
    return Object.fromEntries(bands);
  }

  if (bands && typeof bands === 'object') {
    return bands;
  }

  return {};
};

function getFeeBandsFromConfig(rawConfig = {}) {
  return normalizeClassFeeBands(rawConfig.classFeeBands);
}

function getAmountPerDay(student, feeConfig) {
  if (!student || !feeConfig) return 0;

  const className = normalizeClassName(student?.class?.name ?? student?.className ?? '');
  const classId = student?.class?._id ? String(student.class._id) : null;

  // 1️⃣ Class-specific fee (by ID)
  if (classId && feeConfig.classFeeBands && feeConfig.classFeeBands.get(classId)) {
    const band = feeConfig.classFeeBands.get(classId);
    if (typeof band === 'object') return Number(band.amount ?? 0);
    return Number(band ?? 0);
  }

  // 2️⃣ Class-specific fee (by class name)
  if (className && feeConfig.classFeeBands) {
    for (const [key, value] of feeConfig.classFeeBands.entries()) {
      if (typeof value === 'object' && normalizeClassName(value.className) === className) {
        return Number(value.amount ?? 0);
      }
    }
  }

  return 0;
}

function getClassFeeBands(feeConfig) {
  if (!feeConfig) return {};
  return normalizeClassFeeBands(feeConfig.classFeeBands);
}

// --------------------- Model Export ---------------------
feedingFeeConfigSchema.statics.getAmountPerDay = getAmountPerDay;
feedingFeeConfigSchema.statics.getClassFeeBands = getClassFeeBands;
feedingFeeConfigSchema.statics.getFeeBandsFromConfig = getFeeBandsFromConfig;

module.exports = mongoose.model('FeedingFeeConfig', feedingFeeConfigSchema);
