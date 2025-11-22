const mongoose = require('mongoose');

// --------------------- Schema Definition ---------------------
const feedingFeeConfigSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },

  // Category-based (legacy fallback)
  feeBands: {
    crecheToKG2: { type: Number, default: 0 },
    basic1To6: { type: Number, default: 0 },
    basic7To9: { type: Number, default: 0 },
    default: { type: Number, default: 0 },
  },

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

function getFeeBandsFromConfig(rawConfig = {}) {
  // 1️⃣ Prefer class-based structure
  if (rawConfig.classFeeBands && typeof rawConfig.classFeeBands === 'object') {
    return rawConfig.classFeeBands;
  }

  // 2️⃣ Fallback: category-based
  if (rawConfig.feeBands && typeof rawConfig.feeBands === 'object') {
    return rawConfig.feeBands;
  }

  // 3️⃣ Legacy flat structure
  return {
    crecheToKG2: rawConfig.crecheToKG2 ?? rawConfig.credeToKG2 ?? rawConfig.creche ?? rawConfig.crede ?? 0,
    basic1To6: rawConfig.basic1To6 ?? rawConfig.basic_1_to_6 ?? rawConfig.basic1 ?? 0,
    basic7To9: rawConfig.basic7To9 ?? rawConfig.basic_7_to_9 ?? rawConfig.basic7 ?? 0,
  };
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

  // 3️⃣ Category-based fallback
  const bands = getFeeBandsFromConfig(feeConfig);

  if (['crèche', 'creche', 'nursery 1', 'nursery2', 'nursery 2', 'kg 1', 'kg1', 'kg 2', 'kg2']
    .some(k => className.includes(k))) {
    return Number(bands.crecheToKG2 || 0);
  }

  if (/basic\s*[1-6]|grade\s*[1-6]/.test(className)) {
    return Number(bands.basic1To6 || 0);
  }

  if (/basic\s*[7-9]|grade\s*[7-9]|jhs|junior high/.test(className)) {
    return Number(bands.basic7To9 || 0);
  }

  return Number(bands.default || 0);
}

function getClassFeeBands(feeConfig) {
  if (!feeConfig) return {};
  if (feeConfig.classFeeBands && typeof feeConfig.classFeeBands === 'object') {
    return Object.fromEntries(feeConfig.classFeeBands);
  }
  const bands = getFeeBandsFromConfig(feeConfig);
  return {
    crecheToKG2: bands.crecheToKG2,
    basic1To6: bands.basic1To6,
    basic7To9: bands.basic7To9
  };
}

// --------------------- Model Export ---------------------
feedingFeeConfigSchema.statics.getAmountPerDay = getAmountPerDay;
feedingFeeConfigSchema.statics.getClassFeeBands = getClassFeeBands;
feedingFeeConfigSchema.statics.getFeeBandsFromConfig = getFeeBandsFromConfig;

module.exports = mongoose.model('FeedingFeeConfig', feedingFeeConfigSchema);
