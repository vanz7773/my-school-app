const mongoose = require('mongoose');

const normalizeClassName = (s) => (s || '').toString().toLowerCase().trim();

/**
 * 🧩 Get amount per day for a given student.
 * Supports both class-based and legacy category-based fee configurations.
 */
function getAmountPerDay(student, feeConfig) {
  if (!student || !feeConfig) return 0;

  const classId = student.class?._id ? String(student.class._id) : String(student.class);
  const className = normalizeClassName(student?.class?.name ?? student?.className ?? '');

  // 🟢 1️⃣ Class-based fee lookup (Map structure)
  if (feeConfig.classFeeBands instanceof Map && feeConfig.classFeeBands.has(classId)) {
    const band = feeConfig.classFeeBands.get(classId);
    if (band && typeof band === 'object') return Number(band.amount || 0);
  }

  // 🟢 2️⃣ Try to match by class name (case-insensitive)
  if (feeConfig.classFeeBands instanceof Map) {
    for (const [, value] of feeConfig.classFeeBands.entries()) {
      if (normalizeClassName(value?.className) === className) {
        return Number(value.amount || 0);
      }
    }
  }

  // 🟢 3️⃣ Fallback: use legacy category system
  return getAmountPerDayByCategory(student, feeConfig);
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

/**
 * 🟣 Legacy + universal system: category-based fee structure.
 * Supports BASIC / GRADE / PRIMARY / JHS / CRECHE naming conventions.
 */
function getAmountPerDayByCategory(student, feeConfig) {
  if (!student || !feeConfig) return 0;
  const bands = getFeeBandsFromConfig(feeConfig);
  const className = normalizeClassName(student?.class?.name ?? student?.className ?? '');

  // 🧠 Group A: Crèche / Nursery / KG / Kindergarten
  if (['crèche', 'creche', 'nursery', 'kg', 'kindergarten'].some(k => className.includes(k))) {
    return Number(bands.crecheToKG2 || 0);
  }

  // 🧠 Group B: Basic / Grade / Primary 1–6
  if (/(basic|grade|primary)\s*[1-6]/.test(className)) {
    return Number(bands.basic1To6 || 0);
  }

  // 🧠 Group C: Basic / Grade / Primary 7–9 / JHS / Junior High
  if (/(basic|grade|primary)\s*[7-9]|jhs|junior high/.test(className)) {
    return Number(bands.basic7To9 || 0);
  }

  // Fallback
  return Number(bands.default || 0);
}

/**
 * 🔹 Get the correct fee bands structure (works for both old & new).
 */
function getFeeBandsFromConfig(rawConfig = {}) {
  // Map-based (modern)
  if (rawConfig.classFeeBands instanceof Map) {
    const obj = {};
    for (const [key, val] of rawConfig.classFeeBands.entries()) {
      obj[key] = val;
    }
    return obj;
  }

  // Category-based (legacy)
  if (rawConfig.feeBands && typeof rawConfig.feeBands === 'object') {
    return rawConfig.feeBands;
  }

  // Legacy flat structure fallback
  return {
    crecheToKG2: rawConfig.crecheToKG2 ?? rawConfig.credeToKG2 ?? rawConfig.creche ?? rawConfig.crede ?? 0,
    basic1To6: rawConfig.basic1To6 ?? rawConfig.basic_1_to_6 ?? rawConfig.basic1 ?? 0,
    basic7To9: rawConfig.basic7To9 ?? rawConfig.basic_7_to_9 ?? rawConfig.basic7 ?? 0,
    default: rawConfig.default ?? 0,
  };
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

    // 🧠 Group A: Crèche / Nursery / KG / Kindergarten
    if (['crèche', 'creche', 'nursery', 'kg', 'kindergarten'].some(k => name.includes(k))) {
      amount = legacyBands.crecheToKG2 || 0;
    }
    // 🧠 Group B: Basic / Grade / Primary 1–6
    else if (/(basic|grade|primary)\s*[1-6]/.test(name)) {
      amount = legacyBands.basic1To6 || 0;
    }
    // 🧠 Group C: Basic / Grade / Primary 7–9 / JHS / Junior High
    else if (/(basic|grade|primary)\s*[7-9]|jhs|junior high/.test(name)) {
      amount = legacyBands.basic7To9 || 0;
    }

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
