const mongoose = require('mongoose');

const classFeeConfigSchema = new mongoose.Schema(
  {
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      unique: true,
      index: true,
    },
    classFeeBands: {
      type: Map,
      of: {
        className: { type: String },
        amount: { type: Number, default: 0, min: 0 },
      },
      default: {},
    },
    currency: { type: String, default: 'GHS' },
    lastUpdated: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const normalizeClassFeeBands = (bands = {}) => {
  if (bands instanceof Map) return Object.fromEntries(bands);
  if (bands && typeof bands === 'object') return bands;
  return {};
};

classFeeConfigSchema.statics.getClassFeeBands = function getClassFeeBands(config) {
  return normalizeClassFeeBands(config?.classFeeBands);
};

classFeeConfigSchema.statics.getAmountForClass = function getAmountForClass(config, classDoc) {
  if (!config || !classDoc) return 0;

  const bands = normalizeClassFeeBands(config.classFeeBands);
  const classId = String(classDoc._id || '');
  const directBand = bands[classId];

  if (directBand && typeof directBand === 'object') {
    return Number(directBand.amount) || 0;
  }

  if (typeof directBand === 'number') {
    return Number(directBand) || 0;
  }

  const className = String(classDoc.displayName || classDoc.name || '').toLowerCase().trim();
  const namedBand = Object.values(bands).find((band) => (
    band &&
    typeof band === 'object' &&
    String(band.className || '').toLowerCase().trim() === className
  ));

  return Number(namedBand?.amount) || 0;
};

module.exports =
  mongoose.models.ClassFeeConfig ||
  mongoose.model('ClassFeeConfig', classFeeConfigSchema);
