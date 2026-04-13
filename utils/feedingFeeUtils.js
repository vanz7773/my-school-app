const mongoose = require('mongoose');

const normalizeClassName = (s) => (s || '').toString().toLowerCase().trim();

/**
 * 🧩 Get amount per day for a given student.
 * Handles both Map (live Mongoose doc) and plain Object (lean query) forms of classFeeBands.
 */
function getAmountPerDay(student, feeConfig) {
  if (!student || !feeConfig) return 0;

  const classId = student.class?._id ? String(student.class._id) : String(student.class || '');
  const className = normalizeClassName(student?.class?.name ?? student?.className ?? '');

  const bands = feeConfig.classFeeBands;
  if (!bands) return 0;

  // ── Case 1: Mongoose Map (non-lean document) ──
  if (bands instanceof Map) {
    if (classId && bands.has(classId)) {
      const band = bands.get(classId);
      return Number(band?.amount || 0);
    }
    for (const [, value] of bands.entries()) {
      if (normalizeClassName(value?.className) === className) {
        return Number(value?.amount || 0);
      }
    }
    return 0;
  }

  // ── Case 2: Plain Object (lean query result) ──
  if (typeof bands === 'object') {
    if (classId && bands[classId]) {
      return Number(bands[classId]?.amount || 0);
    }
    for (const value of Object.values(bands)) {
      if (typeof value === 'object' && normalizeClassName(value?.className) === className) {
        return Number(value?.amount || 0);
      }
    }
  }

  return 0;
}

/**
 * 🔹 Get amount per day for a specific class (by classId only).
 */
function getAmountPerDayForClass(classId, feeConfig) {
  if (!classId || !feeConfig) return 0;
  const classIdStr = String(classId);

  if (feeConfig.classFeeBands instanceof Map && feeConfig.classFeeBands.has(classIdStr)) {
    const band = feeConfig.classFeeBands.get(classIdStr);
    return Number(band?.amount || 0);
  }

  return 0;
}

/**
 * 🔹 Build a plain object or Map of class fee bands for easy iteration.
 */
function getClassFeeBandsMap(feeConfig) {
  if (!feeConfig || !(feeConfig.classFeeBands instanceof Map)) return new Map();
  return feeConfig.classFeeBands;
}

/**
 * ✅ Alias for backward compatibility:
 * Provides the same data as getClassFeeBandsMap but as a plain object.
 */
function getClassFeeBands(feeConfig) {
  const map = getClassFeeBandsMap(feeConfig);
  if (map instanceof Map) {
    return Object.fromEntries(map);
  }
  return map || {};
}

/**
 * 🔹 Update or create a class fee band entry.
 */
function updateClassFeeBand(feeConfig, classId, amount, meta = {}) {
  if (!feeConfig || !classId) return feeConfig;
  const amountNum = Number(amount) || 0;
  const classIdStr = String(classId);

  if (!(feeConfig.classFeeBands instanceof Map)) {
    feeConfig.classFeeBands = new Map();
  }

  const current = feeConfig.classFeeBands.get(classIdStr) || {};
  feeConfig.classFeeBands.set(classIdStr, {
    ...current,
    ...meta,
    amount: amountNum,
  });

  return feeConfig;
}

/**
 * 🔹 Remove a class fee band by classId.
 */
function removeClassFeeBand(feeConfig, classId) {
  if (!feeConfig || !(feeConfig.classFeeBands instanceof Map) || !classId) return feeConfig;
  const classIdStr = String(classId);
  feeConfig.classFeeBands.delete(classIdStr);
  return feeConfig;
}

function getAmountPerDayByCategory(student, feeConfig) {
  return 0;
}

/**
 * 🔹 Get the correct fee bands structure (works for both old & new).
 */
function getFeeBandsFromConfig(rawConfig = {}) {
  if (rawConfig.classFeeBands instanceof Map) {
    const obj = {};
    for (const [key, val] of rawConfig.classFeeBands.entries()) {
      obj[key] = val;
    }
    return obj;
  }

  if (rawConfig.classFeeBands && typeof rawConfig.classFeeBands === 'object') {
    return rawConfig.classFeeBands;
  }

  return {};
}

/**
 * 🔹 Detect whether a config is using class-based bands.
 */
function isUsingClassBands(feeConfig) {
  return feeConfig?.classFeeBands instanceof Map;
}

/**
 * 🔹 Migration helper: convert legacy config into class-based format.
 * Automatically maps GRADE / BASIC / PRIMARY class names to correct bands.
 */
async function migrateToClassBands(feeConfig, classModel) {
  if (!feeConfig || !classModel) return feeConfig;
  if (isUsingClassBands(feeConfig)) return feeConfig;

  const legacyBands = getFeeBandsFromConfig(feeConfig);
  const classes = await classModel.find({}).select('_id name level').lean();

  const classFeeMap = new Map();
  for (const cls of classes) {
    const name = normalizeClassName(cls.name);
    let amount = 0;

    const matchingBand = legacyBands[String(cls._id)] || legacyBands[cls.name] || null;
    amount = Number(matchingBand?.amount || matchingBand || 0);

    if (amount > 0) {
      classFeeMap.set(String(cls._id), {
        className: cls.name,
        level: cls.level,
        amount,
      });
    }
  }

  feeConfig.classFeeBands = classFeeMap;
  return feeConfig;
}

module.exports = {
  getAmountPerDay,
  getAmountPerDayForClass,
  getAmountPerDayByCategory,
  getFeeBandsFromConfig,
  getClassFeeBandsMap,
  getClassFeeBands, // ✅ alias for compatibility
  updateClassFeeBand,
  removeClassFeeBand,
  isUsingClassBands,
  migrateToClassBands,
};
