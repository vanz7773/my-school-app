// controllers/feedingFeeController.js
const mongoose = require('mongoose');
const StudentAttendance = require('../models/StudentAttendance');
const Student = require('../models/Student');
const FeedingFeeConfig = require('../models/FeedingFeeConfig');
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const Term = require("../models/term");
const Class = require('../models/Class');
const Notification = require('../models/Notification');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();
const { attendanceQueue } = require('../queue/attendanceQueue');


// 🔔 Reusable Push Sender (same as announcements)
async function sendPush(userIds, title, body, data = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false,
  }).lean();

  const validTokens = tokens
    .map(t => t.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (validTokens.length === 0) return;

  const messages = validTokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
  }
}


// --------------------------------------------------------------------
// 🔍 Cache for frequently accessed data
// --------------------------------------------------------------------
const feeConfigCache = new Map();
const classCache = new Map();
const studentCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --------------------------------------------------------------------
// 🔧 Helper: Get fee config with caching
// --------------------------------------------------------------------
async function getFeeConfigWithCache(schoolId) {
  const cacheKey = `feeConfig_${schoolId}`;
  const cached = feeConfigCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const config = await FeedingFeeConfig.findOne({ school: schoolId });

  if (config) {
    feeConfigCache.set(cacheKey, { data: config, timestamp: Date.now() });
  }

  return config;
}
// 🧩 Helper: Resolve class display name safely
const resolveClassNames = (classDoc) => {
  if (!classDoc) {
    return {
      className: "Unknown Class",
      classDisplayName: "Unknown Class",
    };
  }

  return {
    className: classDoc.name,
    classDisplayName:
      classDoc.displayName ||
      `${classDoc.name}${classDoc.stream || ""}`,
  };
};

// --------------------------------------------------------------------
// 🔧 Helper: Get class with caching
// --------------------------------------------------------------------
async function getClassWithCache(classId, schoolId) {
  const cacheKey = `class_${classId}_${schoolId}`;
  const cached = classCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const classDoc = await Class.findOne({ _id: classId, school: schoolId }).lean();

  if (classDoc) {
    classCache.set(cacheKey, { data: classDoc, timestamp: Date.now() });
  }

  return classDoc;
}

// --------------------------------------------------------------------
// 🔧 Helper: Get student with caching
// --------------------------------------------------------------------
async function getStudentWithCache(studentId, schoolId, userId = null) {
  const cacheKey = `student_${studentId}_${schoolId}_${userId || 'none'}`;
  const cached = studentCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  let query = { _id: studentId, school: schoolId };

  // For parent access, verify ownership
  if (userId) {
    query.$or = [
      { parent: userId },
      { parentIds: { $in: [userId] } }
    ];
  }

  const student = await Student.findOne(query)
    .populate("class")
    .populate("user")
    .lean();

  if (student) {
    studentCache.set(cacheKey, { data: student, timestamp: Date.now() });
  }

  return student;
}

// --------------------------------------------------------------------
// 🔧 Create feeding fee notification + PUSH SUPPORT
// --------------------------------------------------------------------
async function createFeedingFeeNotification(req, {
  title,
  sender,
  school,
  studentId,
  studentName,
  action = "updated"
}) {
  try {
    const actionMap = {
      updated: "Feeding Fee Updated",
      paid: "Feeding Fee Payment",
      marked: "Feeding Status Changed"
    };

    const isRecovered = title === "💰 Recovered Feeding Fee Debt";
    const notificationTitle = isRecovered ? title : `${actionMap[action]}: ${studentName}`;

    // 1️⃣ Create in-app notification
    const notif = await Notification.create({
      title: notificationTitle,
      sender,
      school,
      message: `Feeding fee ${action} for ${studentName}`,
      type: "feedingfee",
      audience: isRecovered ? "all" : "parent",
      studentId,
      recipientRoles: isRecovered ? ["admin", "parent", "student"] : ["parent"],
      recipientUsers: [] // Will be populated below with resolved user IDs
    });

    // 2️⃣ Find all parent user IDs, and optionally the student user ID
    const studentDoc = await Student.findById(studentId)
      .select("parent parentIds user")
      .lean();

    let parentUsers = [];
    if (studentDoc?.parent) parentUsers.push(String(studentDoc.parent));
    if (Array.isArray(studentDoc?.parentIds)) {
      parentUsers.push(...studentDoc.parentIds.map(p => String(p)));
    }
    parentUsers = [...new Set(parentUsers)];

    // 3️⃣ SEND PUSH TO ALL PARENTS (and ADMINS + STUDENT if recovered)
    const pushTargets = [...parentUsers];

    if (isRecovered) {
      // Add student's user ID so student gets notified
      if (studentDoc?.user) {
        pushTargets.push(String(studentDoc.user));
      }

      // Add all school admins so admins get notified
      const User = mongoose.model('User');
      const adminUsers = await User.find({ school, role: 'admin' }).select('_id').lean();
      pushTargets.push(...adminUsers.map(a => String(a._id)));
    }

    // Deduplicate targets
    const dedupedTargets = [...new Set(pushTargets)];

    // Update notification with resolved recipientUsers so broadcastNotification
    // can deliver socket events and web push to all targets (even offline admins)
    if (dedupedTargets.length > 0) {
      notif.recipientUsers = dedupedTargets;
      await notif.save();
    }

    if (dedupedTargets.length > 0) {
      await sendPush(
        dedupedTargets,
        notificationTitle,
        `Feeding fee ${action} for ${studentName}`,
        { type: "feedingfee", studentId }
      );
    }

    // 4️⃣ Emit socket event & web-push via broadcastNotification
    if (req) {
      await broadcastNotification(req, notif);
    }

    return notif;

  } catch (err) {
    console.error("⚠️ Feeding Fee Push Notification Error:", err);
  }
}

// Safe ObjectId conversion
const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

// Utility: Normalize week number
const normalizeWeekNumber = (week) => {
  if (!week) return 1;
  return typeof week === 'string' ? parseInt(week.replace(/Week\s*/i, '').trim(), 10) || 1 : parseInt(week, 10) || 1;
};

// 🟢 CORRECTED: Consistent day normalization
const normalizeDayValue = (val) => {
  if (val === true || val === 'present') return 'present';
  if (val === false || val === 'absent') return 'absent';
  if (val === 'unpaid') return 'unpaid'; // Explicit Feeding Fee page "Mark as Unpaid"
  return 'notmarked';
};

const ensureDefaultDays = (days = {}) => ({
  M: normalizeDayValue(days.M),
  T: normalizeDayValue(days.T),
  W: normalizeDayValue(days.W),
  TH: normalizeDayValue(days.TH),
  F: normalizeDayValue(days.F),
});

const ensureDefaultPaidAt = (paidAt = {}) => ({
  M: paidAt.M || null,
  T: paidAt.T || null,
  W: paidAt.W || null,
  TH: paidAt.TH || null,
  F: paidAt.F || null,
});

// Helper to get full student name
const getFullStudentName = (student) => {
  if (!student) return "Unknown Student";
  return (
    student.user?.name ||
    student.name ||
    (student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : null) ||
    "Unnamed Student"
  );
};

// 🧩 Helper to determine student feeding category based on class name or level
function getStudentCategory(student) {
  if (!student || !student.class || !student.class.name) return 'creche-kg2';

  const className = student.class.name.toLowerCase();

  if (className.includes('creche') || className.includes('kg') || className.includes('nursery')) {
    return 'creche-kg2';
  } else if (className.includes('basic 1') || className.includes('basic1') ||
    className.includes('basic 2') || className.includes('basic2') ||
    className.includes('basic 3') || className.includes('basic3') ||
    className.includes('basic 4') || className.includes('basic4') ||
    className.includes('basic 5') || className.includes('basic5') ||
    className.includes('basic 6') || className.includes('basic6')) {
    return 'basic1-6';
  } else if (className.includes('basic 7') || className.includes('jhs') ||
    className.includes('basic7') || className.includes('basic8') ||
    className.includes('basic9')) {
    return 'basic7-9';
  }

  return 'creche-kg2';
}

// Utility: Get start date of a term week
const getWeekStartDate = (term, weekNumber) => {
  const startDate = new Date(term.startDate);
  const weekStart = new Date(startDate);
  weekStart.setDate(startDate.getDate() + (weekNumber - 1) * 7);
  return weekStart;
};

const WEEK_DAY_KEYS = ['M', 'T', 'W', 'TH', 'F'];

const getWeekDayDates = (term, weekNumber) => {
  const weekStart = getWeekStartDate(term, weekNumber);
  return {
    M: new Date(weekStart),
    T: new Date(weekStart.getTime() + 1 * 86400000),
    W: new Date(weekStart.getTime() + 2 * 86400000),
    TH: new Date(weekStart.getTime() + 3 * 86400000),
    F: new Date(weekStart.getTime() + 4 * 86400000),
  };
};

const isSameCalendarDay = (left, right) => {
  if (!left || !right) return false;
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
};

const getAccountedAmountForDay = (entry, targetDay, targetDate, amountPerDay = 0) => {
  const fallbackAmount = Number(entry?.perDayFee?.[targetDay]) || 0;
  const resolvedAmount = Number(amountPerDay) > 0 ? Number(amountPerDay) : fallbackAmount;

  if (resolvedAmount <= 0) return 0; // Quick exit safety

  let amountForTargetDay = 0;

  for (const dayKey of WEEK_DAY_KEYS) {
    // Only process days that are actually paid
    const isPaidDay = entry?.days?.[dayKey] === 'present';
    if (!isPaidDay) continue;

    const paidAt = entry.paidAt?.[dayKey];

    // Case 1: No timestamp tracking (e.g. from Student Attendance page or legacy records)
    if (!paidAt) {
      if (targetDay === dayKey) {
        amountForTargetDay += resolvedAmount;
      }
      continue;
    }

    // Case 2: Timestamp tracked. Map the payment to the correct UI Tab logically based on day of week.
    // Out-of-bounds safety rule: If this is a very late payment (e.g. Debt recovery paid weeks later),
    // we bypass the "payment day" mapping and force it to its original feeding day so it isn't orphaned.
    let mappedTab;
    const isVastlyDisconnected = targetDate && paidAt ? (Math.abs(new Date(paidAt) - new Date(targetDate)) / 86400000) > 5 : false;

    if (isVastlyDisconnected) {
      mappedTab = dayKey; // Lock it onto the indigenous feeding day
    } else {
      const paymentDayOfWeek = new Date(paidAt).getDay(); // 0(Sun) - 6(Sat)
      if (paymentDayOfWeek === 0 || paymentDayOfWeek === 1 || paymentDayOfWeek === 6) mappedTab = 'M';
      else if (paymentDayOfWeek === 2) mappedTab = 'T';
      else if (paymentDayOfWeek === 3) mappedTab = 'W';
      else if (paymentDayOfWeek === 4) mappedTab = 'TH';
      else if (paymentDayOfWeek === 5) mappedTab = 'F';
    }

    if (mappedTab === targetDay) {
      amountForTargetDay += resolvedAmount;
    }
  }

  return amountForTargetDay;
};

const resolveEntryAmountPerDay = (entry, record, feeConfig) => {
  if (entry?.student && feeConfig) {
    const liveAmount = getAmountPerDay(entry.student, feeConfig);
    if (liveAmount > 0) return Number(liveAmount) || 0;
  }

  const directAmount = Number(entry?.classFeeAmount || record?.classFeeAmount || entry?.amountPerDay || 0);
  if (directAmount > 0) return directAmount;

  if (entry?.perDayFee) {
    const legacyAmount = Number(
      entry.perDayFee.M ||
      entry.perDayFee.T ||
      entry.perDayFee.W ||
      entry.perDayFee.TH ||
      entry.perDayFee.F ||
      0
    );
    if (legacyAmount > 0) return legacyAmount;
  }

  return 0;
};

// Import updated utility functions
let getAmountPerDay, getAmountPerDayForClass, getClassFeeBands, getFeeBandsFromConfig;
try {
  const feeUtils = require('../utils/feedingFeeUtils');
  getAmountPerDay = feeUtils.getAmountPerDay;
  getAmountPerDayForClass = feeUtils.getAmountPerDayForClass;
  getClassFeeBands = feeUtils.getClassFeeBands;
  getFeeBandsFromConfig = feeUtils.getFeeBandsFromConfig;
} catch {
  // Fallback to basic implementation
  getAmountPerDay = (student, config) => {
    if (!config) return 0;
    const className = (student?.class?.name || '').toLowerCase().trim();
    if (!className) return 0;

    if (config.classFeeBands && config.classFeeBands instanceof Map) {
      const classId = student?.class?._id ? String(student.class._id) : String(student.class);
      if (classId && config.classFeeBands.has(classId)) {
        const band = config.classFeeBands.get(classId);
        return Number(band?.amount || 0);
      }

      for (const [, value] of config.classFeeBands.entries()) {
        if ((value?.className || '').toLowerCase().trim() === className) {
          return Number(value?.amount || 0);
        }
      }
    }

    return 0;
  };

  getAmountPerDayForClass = (classId, config) => {
    if (!config || !classId) return 0;
    if (config.classFeeBands && config.classFeeBands instanceof Map && config.classFeeBands.has(String(classId))) {
      const band = config.classFeeBands.get(String(classId));
      return Number(band?.amount || 0);
    }
    return 0;
  };

  getClassFeeBands = (config) => {
    if (!config) return {};
    return getFeeBandsFromConfig(config);
  };

  getFeeBandsFromConfig = (rawConfig = {}) => {
    if (rawConfig.classFeeBands instanceof Map) {
      return Object.fromEntries(rawConfig.classFeeBands);
    }

    if (rawConfig.classFeeBands && typeof rawConfig.classFeeBands === 'object') {
      return rawConfig.classFeeBands;
    }

    return {};
  };
}

// --------------------------------------------------------------------
// ⚙️ Process Background Feeding Job — ATOMIC (no VersionError possible)
// Uses findOneAndUpdate + $set instead of record.save()
// Multiple concurrent taps for the same student are handled safely.
// --------------------------------------------------------------------
const processFeedingJob = async (jobData) => {
  const { student, termId, classId, week, fed, day, reqUser } = jobData;
  const schoolId = reqUser.school;
  const weekNumber = normalizeWeekNumber(week);

  // 1️⃣ Validate inputs early
  if (!["M", "T", "W", "TH", "F"].includes(day)) {
    return { success: false, status: 400, message: "Invalid day key. Must be one of M, T, W, TH, F" };
  }

  // 2️⃣ Config + student (both cached)
  const feeConfig = await getFeeConfigWithCache(schoolId);
  if (!feeConfig) return { success: false, status: 404, message: "Feeding fee config not found" };

  const studentDoc = await getStudentWithCache(student, schoolId);
  if (!studentDoc) return { success: false, status: 404, message: "Student not found" };

  const amountPerDay = getAmountPerDay(studentDoc, feeConfig);
  const category = getStudentCategory(studentDoc);
  const normalizedValue = normalizeDayValue(fed);
  const studentObjId = toObjectId(student);

  // 3️⃣ 🚦 Debt recovery detection
  let isRecoveredDebt = false;
  if (normalizedValue === "present") {
    const today = new Date();
    const termInfo = await Term.findOne({ _id: termId, school: schoolId }).lean();
    if (termInfo?.startDate) {
      const weekStart = new Date(termInfo.startDate);
      weekStart.setDate(weekStart.getDate() + (weekNumber - 1) * 7);
      const weekFriday = new Date(weekStart);
      weekFriday.setDate(weekStart.getDate() + 4);
      weekFriday.setHours(23, 59, 59, 999);
      if (today > weekFriday) isRecoveredDebt = true;
    }
  }

  // 4️⃣ Ensure the week record exists — atomic upsert, no VersionError
  await FeedingFeeRecord.findOneAndUpdate(
    { classId, termId, school: schoolId, week: weekNumber },
    {
      $setOnInsert: {
        school: schoolId, classId, termId, week: weekNumber, category,
        breakdown: [], totalCollected: 0, amountCollected: 0,
        configType: "class-based", classFeeAmount: amountPerDay,
        lastUpdatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  // 5️⃣ Read current state for this student's breakdown entry
  const currentRecord = await FeedingFeeRecord.findOne(
    { classId, termId, school: schoolId, week: weekNumber }
  ).lean();

  const existingEntry = currentRecord?.breakdown?.find(
    (b) => b.student.toString() === student
  );

  if (existingEntry) {
    // ── EXISTING entry: update the specific day field atomically ──────────
    // Uses positional $ operator — bypasses __v entirely, zero VersionError
    const mergedDays = ensureDefaultDays({ ...existingEntry.days, [day]: normalizedValue });
    const mergedPaidAt = {
      ...(existingEntry.paidAt || { M: null, T: null, W: null, TH: null, F: null }),
      [day]: normalizedValue === "present" ? new Date() : null,
    };

    const daysPaid = Object.values(mergedDays).filter((v) => v === "present").length;
    const perDayFee = {};
    for (const dk of ["M", "T", "W", "TH", "F"]) {
      perDayFee[dk] = mergedDays[dk] === "present" ? amountPerDay : 0;
    }
    const amount = daysPaid * amountPerDay;

    // Compute new class total using all OTHER students' existing amounts
    const newClassTotal = (currentRecord.breakdown || []).reduce((sum, b) => {
      if (b.student.toString() === student) return sum + amount; // use newly computed amount
      return sum + (b.amount || 0);
    }, 0);

    // ⚠️  CRITICAL FIX: Write ONLY the specific day field, not the whole days object.
    // Before: `"breakdown.$.days": { M:"present", T:"notmarked"... }` — last writer KILLS other days
    // After:  `"breakdown.$.days.M": "present"` — each day is its own independent MongoDB field
    // Concurrent M and T taps now write to separate paths and NEVER overwrite each other.
    await FeedingFeeRecord.findOneAndUpdate(
      {
        classId, termId, school: schoolId, week: weekNumber,
        "breakdown.student": studentObjId,
      },
      {
        $set: {
          [`breakdown.$.days.${day}`]: normalizedValue,
          [`breakdown.$.paidAt.${day}`]: normalizedValue === "present" ? new Date() : null,
          "breakdown.$.daysPaid": daysPaid,
          "breakdown.$.perDayFee": perDayFee,
          "breakdown.$.amount": amount,
          "breakdown.$.total": amount,
          "breakdown.$.classFeeAmount": amountPerDay,
          "breakdown.$.currency": feeConfig.currency || "GHS",
          "breakdown.$.lastUpdatedAt": new Date(),
          ...(isRecoveredDebt && { "breakdown.$.isRecoveredDebt": true }),
          totalCollected: newClassTotal,
          amountCollected: newClassTotal,
          classFeeAmount: amountPerDay,
          lastUpdatedAt: new Date(),
        },
      }
    );

    // 🔔 Notification in background
    if (normalizedValue === "present") {
      setImmediate(() => sendFeedingNotification({ isRecoveredDebt, reqUser, schoolId, student, studentDoc, weekNumber, day }));
    }

    // 🔟 Clear caches
    studentCache.delete(`student_${student}_${schoolId}_none`);
    feeConfigCache.delete(`feeConfig_${schoolId}`);

    return {
      success: true,
      message: formatMarkMessage(getFullStudentName(studentDoc), normalizedValue, day, weekNumber),
      updatedDays: mergedDays,
      perDayFee,
      amountPerDay,
      totalAmount: amount,
      daysPaid,
      week: weekNumber,
    };

  } else {
    // ── NEW entry: push a brand new breakdown entry atomically ─────────────
    const newDays = ensureDefaultDays({ [day]: normalizedValue });
    const newPaidAt = { M: null, T: null, W: null, TH: null, F: null };
    newPaidAt[day] = normalizedValue === "present" ? new Date() : null;

    const daysPaid = normalizedValue === "present" ? 1 : 0;
    const perDayFee = {};
    for (const dk of ["M", "T", "W", "TH", "F"]) {
      perDayFee[dk] = newDays[dk] === "present" ? amountPerDay : 0;
    }
    const amount = daysPaid * amountPerDay;

    const newEntry = {
      student: studentObjId,
      studentName: getFullStudentName(studentDoc),
      className: studentDoc.class?.name || "Unknown Class",
      classFeeAmount: amountPerDay,
      amount,
      total: amount,
      daysPaid,
      perDayFee,
      days: newDays,
      paidAt: newPaidAt,
      currency: feeConfig.currency || "GHS",
      lastUpdatedAt: new Date(),
      ...(isRecoveredDebt && { isRecoveredDebt: true }),
    };

    const newClassTotal = (currentRecord?.breakdown || []).reduce((sum, b) => sum + (b.amount || 0), amount);

    // Atomic $push — no version check, no conflict
    await FeedingFeeRecord.findOneAndUpdate(
      { classId, termId, school: schoolId, week: weekNumber },
      {
        $push: { breakdown: newEntry },
        $set: {
          totalCollected: newClassTotal,
          amountCollected: newClassTotal,
          classFeeAmount: amountPerDay,
          lastUpdatedAt: new Date(),
        },
      }
    );

    // 🔔 Notification in background
    if (normalizedValue === "present") {
      setImmediate(() => sendFeedingNotification({ isRecoveredDebt, reqUser, schoolId, student, studentDoc, weekNumber, day }));
    }

    // 🔟 Clear caches
    studentCache.delete(`student_${student}_${schoolId}_none`);
    feeConfigCache.delete(`feeConfig_${schoolId}`);

    return {
      success: true,
      message: formatMarkMessage(getFullStudentName(studentDoc), normalizedValue, day, weekNumber),
      updatedDays: newDays,
      perDayFee,
      amountPerDay,
      totalAmount: amount,
      daysPaid,
      week: weekNumber,
    };
  }
};

// ── Small helpers to keep processFeedingJob clean ──────────────────────────

function formatMarkMessage(name, status, day, week) {
  const label = status === "present" ? "fed (present)" : status === "absent" ? "not fed (absent)" : "not marked";
  return `${name} marked as ${label} for ${day} (Week ${week})`;
}

async function sendFeedingNotification({ isRecoveredDebt, reqUser, schoolId, student, studentDoc, weekNumber, day }) {
  try {
    if (isRecoveredDebt) {
      await createFeedingFeeNotification(null, {
        title: "💰 Recovered Feeding Fee Debt",
        sender: reqUser._id,
        school: schoolId,
        studentId: student,
        studentName: getFullStudentName(studentDoc),
        action: `recovered for Week ${weekNumber} (${day})`,
      });
    }
    await createFeedingFeeNotification(null, {
      title: "Feeding Fee Updated",
      sender: reqUser._id,
      school: schoolId,
      studentId: student,
      studentName: getFullStudentName(studentDoc),
      action: "updated",
    });
  } catch (err) {
    console.error("⚠️ markFeeding notification failed:", err);
  }
}



// --------------------------------------------------------------------
// ✅ Mark feeding fee - SYNCHRONOUS PROCESSING
// --------------------------------------------------------------------
const markFeeding = async (req, res) => {
  const { student, termId, classId, week, fed, day } = req.body;

  if (!student || !termId || !classId || !week || !day) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: student, termId, classId, week, or day",
    });
  }

  try {
    // Process feeding fee marking directly
    const result = await processFeedingJob({
      student, termId, classId, week, fed, day,
      reqUser: { _id: req.user._id, school: req.user.school } // Pass along required parts of req.user
    });

    if (result && result.success === false) {
      return res.status(result.status || 400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error("❌ Failed to process markFeeding:", err);
    res.status(500).json({ message: "Internal Server Error while marking feeding fee" });
  }
};

// --------------------------------------------------------------------
// ✅ Calculate feeding fee collection WITH CACHING
// --------------------------------------------------------------------
const calculateFeedingFeeCollection = async (req, res) => {
  try {
    const { termId, classId, week, manualPayments = {} } = req.body;
    if (!termId || !classId || !week) {
      return res.status(400).json({
        message: "Missing termId, classId, or week",
      });
    }

    const schoolId = toObjectId(req.user.school);
    const weekNumber = normalizeWeekNumber(week);

    // 🟢 Fetch feeding fee configuration (cached)
    const feeConfig = await getFeeConfigWithCache(schoolId);
    if (!feeConfig)
      return res.status(404).json({ message: "Feeding fee config not found" });

    // 🟢 Fetch class students
    const classStudents = await Student.find({ class: toObjectId(classId) })
      .populate({
        path: "class",
        select: "name level",
      })
      .populate({
        path: "user",
        select: "name",
      });

    console.log(`🟡 Found ${classStudents.length} students in class`);

    // 🧩 Fetch attendance + manual feeding records in parallel (READ ONLY)
    const [attendanceRecords, manualFeedingRecords] = await Promise.all([
      StudentAttendance.find({
        termId: toObjectId(termId),
        class: toObjectId(classId),
        weekNumber,
      }).populate({
        path: "student",
        select: "name firstName lastName class user",
        populate: [
          { path: "class", select: "name level" },
          { path: "user", select: "name" },
        ],
      }),
      FeedingFeeRecord.find({
        termId: toObjectId(termId),
        classId: toObjectId(classId),
        week: weekNumber,
      }).lean(), // ← .lean() enforces read-only: plain JS objects, no Mongoose save() possible
    ]);

    // 🟢 Create map of manual feeding data (read from DB, no writes)
    const feedingMap = new Map();
    for (const record of manualFeedingRecords || []) {
      for (const entry of record.breakdown || []) {
        if (entry.student) {
          feedingMap.set(String(entry.student), {
            daysPaid: entry.daysPaid || 0,
            days: ensureDefaultDays(entry.days),
            storedAmount: entry.amount,
            isRecoveredDebt: entry.isRecoveredDebt || false,
          });
        }
      }
    }

    let totalAmount = 0;
    const breakdown = [];

    // Process all students — all calculations happen in memory only
    for (const student of classStudents) {
      const studentId = String(student._id);
      const studentName = getFullStudentName(student);
      const { className, classDisplayName } = resolveClassNames(student.class);

      // 🧩 Use safe class-based system
      const amountPerDay = getAmountPerDay(student, feeConfig);

      let mergedDays = { M: "notmarked", T: "notmarked", W: "notmarked", TH: "notmarked", F: "notmarked" };

      // Step 1: Seed from attendance records
      const attendance = attendanceRecords.find(
        (a) => a.student && String(a.student._id) === studentId
      );

      if (attendance?.days) {
        for (const dayKey of ["M", "T", "W", "TH", "F"]) {
          const val = attendance.days[dayKey];
          if (val === "present" || val === "absent") {
            mergedDays[dayKey] = normalizeDayValue(val);
          }
        }
      }

      // Step 2: Apply manual feeding overrides (manual teacher marks always win)
      const manual = feedingMap.get(studentId);
      if (manual?.days) {
        const manualValues = Object.values(manual.days);
        // isLikelyAutoSync: record has both 'present' AND 'absent' from attendance page
        // Ignore 'unpaid' in this check — it's always an explicit manual action
        const hasPresent = manualValues.includes("present");
        const hasAbsent = manualValues.includes("absent");
        const isLikelyAutoSync = hasPresent && hasAbsent;

        for (const dayKey of ["M", "T", "W", "TH", "F"]) {
          const manualVal = manual.days[dayKey];
          const currentVal = mergedDays[dayKey];

          // 'unpaid' is ALWAYS an explicit teacher action — always wins
          if (manualVal === "unpaid") {
            mergedDays[dayKey] = "unpaid";
          } else if (isLikelyAutoSync) {
            if (manualVal === "present") mergedDays[dayKey] = "present";
            else if (manualVal === "absent" && (attendance?.days?.[dayKey] === "absent" || attendance?.days?.[dayKey] === "present")) {
              mergedDays[dayKey] = "absent";
            }
          } else {
            if (manualVal === "present") mergedDays[dayKey] = "present";
            else if (manualVal === "absent" && currentVal !== "present") mergedDays[dayKey] = "absent";
          }
        }
      }

      // Step 3: Count paid days and compute amount — pure in-memory math
      const daysPaid = Object.values(mergedDays).filter((v) => v === "present").length;
      const calculatedAmount = daysPaid * amountPerDay;
      totalAmount += calculatedAmount;

      breakdown.push({
        studentId,
        studentName,
        className,
        classDisplayName,
        daysPaid,
        amountPerDay,
        total: calculatedAmount,
        days: ensureDefaultDays(mergedDays),
        isRecoveredDebt: manual?.isRecoveredDebt || false,
      });
    }

    // ✅ NOTE: No database writes occur here.
    // All recalculation and saving of FeedingFeeRecord documents is handled
    // exclusively by processFeedingJob() when a teacher marks a student.
    // This function is a pure read + compute endpoint to eliminate VersionErrors.

    // ✅ Final response
    return res.json({
      success: true,
      classId: String(classId),
      termId: String(termId),
      week: weekNumber,
      totalAmount,
      studentCount: breakdown.length,
      breakdown,
      configUsed: getClassFeeBands(feeConfig),
      currency: feeConfig.currency || "GHS",
      configType: "class-based",
    });
  } catch (error) {
    console.error("❌ Error calculating feeding fee:", error);
    return res.status(500).json({
      success: false,
      message: "Error calculating feeding fee",
      error: error.message,
    });
  }
};


// --------------------------------------------------------------------
// ⚙️ Get feeding fee config WITH CACHING
// --------------------------------------------------------------------
const getFeedingFeeConfig = async (req, res) => {
  try {
    const config = await getFeeConfigWithCache(req.user.school);
    if (!config) return res.status(404).json({ success: false, message: 'Config not found' });

    // Get classes for class-based fee bands
    const classes = await Class.find({ school: req.user.school }).select('name level _id');

    return res.json({
      success: true,
      data: config,
      classes: classes.map((cls) => ({
        _id: cls._id,
        name: cls.name,
        level: cls.level,
      })),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// --------------------------------------------------------------------
// 🔄 Background: Atomically reconcile stale record amounts after fee change
// Uses bulkWrite + $set — no Mongoose .save(), no VersionError possible
// --------------------------------------------------------------------
async function reconcileAmountsAfterConfigChange(schoolId, newConfig) {
  try {
    console.log("🔄 Starting background fee reconciliation for school:", schoolId);

    // Fetch all students for this school with their class populated (for getAmountPerDay)
    const allStudents = await Student.find({ school: schoolId })
      .populate({ path: "class", select: "name level" })
      .populate({ path: "user", select: "name" })
      .lean();

    // Build a studentId → amountPerDay lookup map
    const studentRateMap = new Map();
    for (const student of allStudents) {
      const rate = getAmountPerDay(student, newConfig);
      studentRateMap.set(String(student._id), rate);
    }

    // Fetch all FeedingFeeRecords for this school in one shot (lean = plain objects)
    const allRecords = await FeedingFeeRecord.find({ school: schoolId }).lean();

    if (allRecords.length === 0) {
      console.log("✅ No records to reconcile.");
      return;
    }

    const bulkOps = [];

    for (const record of allRecords) {
      const updatedBreakdown = (record.breakdown || []).map((entry) => {
        const amountPerDay = studentRateMap.get(String(entry.student)) || 0;
        const daysPresent = Object.values(entry.days || {}).filter((v) => v === "present").length;
        const correctAmount = daysPresent * amountPerDay;

        const perDayFee = {};
        for (const dayKey of ["M", "T", "W", "TH", "F"]) {
          perDayFee[dayKey] = entry.days?.[dayKey] === "present" ? amountPerDay : 0;
        }

        return {
          ...entry,
          amount: correctAmount,
          total: correctAmount,
          perDayFee,
          daysPaid: daysPresent,
          lastUpdatedAt: new Date(),
        };
      });

      const newTotal = updatedBreakdown.reduce((sum, e) => sum + (e.amount || 0), 0);

      // ✅ Use $set directly — bypasses Mongoose __v version check entirely
      bulkOps.push({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: {
              breakdown: updatedBreakdown,
              totalCollected: newTotal,
              amountCollected: newTotal,
              lastUpdatedAt: new Date(),
            },
          },
        },
      });
    }

    if (bulkOps.length > 0) {
      const result = await FeedingFeeRecord.bulkWrite(bulkOps, { ordered: false });
      console.log(`✅ Fee reconciliation complete: ${result.modifiedCount}/${allRecords.length} records updated.`);
    }
  } catch (err) {
    // Background job — log but never crash the server
    console.error("⚠️ Background fee reconciliation failed:", err.message);
  }
}

// --------------------------------------------------------------------
// ⚙️ Set feeding fee config WITH NOTIFICATION
// --------------------------------------------------------------------
const setFeedingFeeConfig = async (req, res) => {
  try {
    const { classFeeBands, currency } = req.body;
    const schoolId = req.user.school;

    const update = {
      school: schoolId,
      lastUpdated: new Date()
    };

    // Set class-based fee bands if provided
    if (classFeeBands && typeof classFeeBands === 'object') {
      update.classFeeBands = new Map();

      for (const [classId, bandData] of Object.entries(classFeeBands)) {
        if (bandData && typeof bandData === 'object' && bandData.amount >= 0) {
          update.classFeeBands.set(classId, {
            className: bandData.className || 'Unknown Class',
            amount: Number(bandData.amount),
            level: bandData.level || 'other'
          });
        }
      }
    }

    if (currency) {
      update.currency = currency;
    }

    const config = await FeedingFeeConfig.findOneAndUpdate(
      { school: schoolId },
      update,
      { upsert: true, new: true, runValidators: true }
    );

    // Clear config cache
    feeConfigCache.delete(`feeConfig_${schoolId}`);

    // 🔄 Background: Atomically fix all stale record amounts with the new rate
    // Uses bulkWrite + $set — NO Mongoose .save(), NO VersionError possible
    setImmediate(() => reconcileAmountsAfterConfigChange(schoolId, config));

    // 🔔 Background: Send notification to teachers
    setImmediate(async () => {
      try {
        await Notification.create({
          title: "Feeding Fee Configuration Updated",
          sender: req.user._id,
          school: schoolId,
          message: `Feeding fee configuration updated`,
          type: "fee",
          audience: "teacher",
          recipientRoles: ["teacher"],
        });
      } catch (notifErr) {
        console.error("⚠️ setFeedingFeeConfig notification failed:", notifErr);
      }
    });

    return res.json({
      success: true,
      message: "Feeding fee config updated",
      data: config,
      configType: 'class-based'
    });
  } catch (error) {
    console.error("Config update error:", error);
    return res.status(500).json({
      success: false,
      message: error.message.includes('validation') ? "Invalid fee configuration values" : "Server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


// --------------------------------------------------------------------
// 📊 Get classes with fee bands WITH CACHING
// --------------------------------------------------------------------
const getClassesWithFeeBands = async (req, res) => {
  try {
    const schoolId = req.user.school;

    const [config, classes] = await Promise.all([
      getFeeConfigWithCache(schoolId),
      Class.find({ school: schoolId }).select('name level _id').sort('name')
    ]);

    const classesWithBands = classes.map(cls => {
      const classId = String(cls._id);
      let feeAmount = 0;
      let configSource = 'default';

      if (config && config.classFeeBands && config.classFeeBands.has(classId)) {
        const band = config.classFeeBands.get(classId);
        feeAmount = band.amount;
        configSource = 'class-specific';
      } else {
        configSource = 'not set';
      }

      return {
        _id: cls._id,
        name: cls.name,
        level: cls.level,
        feeAmount,
        configSource
      };
    });

    return res.json({
      success: true,
      classes: classesWithBands,
      hasClassBands: config && config.classFeeBands && config.classFeeBands.size > 0
    });
  } catch (error) {
    console.error('Error getting classes with fee bands:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch classes with fee bands',
      error: error.message
    });
  }
};

// --------------------------------------------------------------------
// 🍽️ Student/Parent Feeding Fee Breakdown WITH CACHING - FIXED VERSION
// --------------------------------------------------------------------
const getFeedingFeeForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { termId, week, childId } = req.query;
    const user = req.user;

    console.log(`🔍 getFeedingFeeForStudent called:`, {
      studentId,
      termId,
      week,
      childId,
      userRole: user.role,
      userId: user._id
    });

    if (!termId || !week) {
      return res.status(400).json({
        success: false,
        message: "Missing termId or week"
      });
    }

    const weekNumber = Number(week);
    const schoolId = user.school;

    // 🟢 Get term
    const term = await Term.findById(termId);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: "Term not found"
      });
    }

    // 🟢 Get fee config
    const feeConfig = await getFeeConfigWithCache(schoolId);
    if (!feeConfig) {
      return res.status(404).json({
        success: false,
        message: "Feeding fee config not found"
      });
    }

    // -----------------------------------------------------
    // 1️⃣ Identify student (FIXED: Proper student resolution)
    // -----------------------------------------------------
    let students = [];

    if (user.role === "student") {
      console.log("🎓 Student role detected, finding student record...");
      // Find student by user ID
      const student = await Student.findOne({
        user: user._id,
        school: schoolId
      })
        .populate("class")
        .populate("user");

      if (!student) {
        return res.status(404).json({
          success: false,
          message: "Student record not found for this user"
        });
      }
      students = [student];
      console.log(`🎓 Found student: ${student._id} - ${getFullStudentName(student)}`);

    } else if (user.role === "parent") {
      console.log("👪 Parent role detected, finding children...");
      const filter = {
        school: schoolId,
        $or: [{ parent: user._id }, { parentIds: { $in: [user._id] } }],
      };

      // Use childId if provided, otherwise use studentId from params
      if (childId && childId !== "undefined") {
        filter._id = childId;
        console.log(`👪 Filtering by childId: ${childId}`);
      } else if (studentId && studentId !== "undefined") {
        filter._id = studentId;
        console.log(`👪 Filtering by studentId: ${studentId}`);
      }

      students = await Student.find(filter)
        .populate("class")
        .populate("user");

      if (!students.length) {
        return res.status(404).json({
          success: false,
          message: "No linked children found for this parent",
        });
      }
      console.log(`👪 Found ${students.length} children for parent`);
    } else {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only students or parents allowed.",
      });
    }

    // -----------------------------------------------------
    // 2️⃣ Build per-student fee breakdown
    // -----------------------------------------------------
    const results = [];
    const allStudentIds = students.map((s) => s._id);

    // Generate week dates
    const weekStart = getWeekStartDate(term, weekNumber);
    const weekDates = {
      M: new Date(weekStart),
      T: new Date(weekStart.getTime() + 1 * 86400000),
      W: new Date(weekStart.getTime() + 2 * 86400000),
      TH: new Date(weekStart.getTime() + 3 * 86400000),
      F: new Date(weekStart.getTime() + 4 * 86400000),
    };

    // 🔔 FETCH NOTIFICATIONS
    const notifications = await Notification.find({
      school: schoolId,
      type: "feedingfee",
      studentId: { $in: allStudentIds },
      $or: [{ recipientUsers: user._id }, { recipientRoles: user.role }],
    })
      .select("studentId isRead createdAt message")
      .lean();

    const notifMap = notifications.reduce((acc, n) => {
      acc[String(n.studentId)] = n;
      return acc;
    }, {});

    for (const student of students) { // Use 'students' array
      const studentName = getFullStudentName(student);
      const { className, classDisplayName } = resolveClassNames(student.class);
      const amountPerDay = getAmountPerDay(student, feeConfig);

      console.log(`📊 Processing student ${studentName}, amountPerDay: ${amountPerDay}`);

      const [attendance, feedingRecord] = await Promise.all([
        StudentAttendance.findOne({
          student: student._id,
          termId,
          weekNumber,
        }).lean(),
        FeedingFeeRecord.findOne({
          classId: student.class?._id,
          termId,
          week: weekNumber,
          school: schoolId,
        }).lean(),
      ]);

      console.log(`📊 Found attendance: ${!!attendance}, feedingRecord: ${!!feedingRecord}`);

      let days = {
        M: "notmarked",
        T: "notmarked",
        W: "notmarked",
        TH: "notmarked",
        F: "notmarked",
      };

      // Merge attendance data
      if (attendance?.days) {
        for (const key of ["M", "T", "W", "TH", "F"]) {
          if (attendance.days[key]) {
            days[key] = attendance.days[key];
          }
        }
      }

      // Merge manual feeding data (overrides attendance)
      const manualEntry = feedingRecord?.breakdown?.find(
        (b) => String(b.student) === String(student._id)
      );
      if (manualEntry?.days) {
        for (const key of ["M", "T", "W", "TH", "F"]) {
          const manualVal = manualEntry.days[key];
          if (manualVal === "present" || manualVal === "absent" || manualVal === "unpaid") {
            days[key] = manualVal;
          }
        }
      }

      const presentDays = Object.values(days).filter(
        (v) => v === "present"
      ).length;
      const total = presentDays * amountPerDay;

      // Build records array for frontend
      const records = Object.entries(days).map(([key, val]) => ({
        day: key,
        status: val,
        amount: val === "present" ? amountPerDay : 0,
        category: student.class?.level || "N/A",
        source: manualEntry?.days?.[key] && manualEntry.days[key] !== "notmarked"
          ? "manual"
          : attendance?.days?.[key]
            ? "attendance"
            : "none",
      }));

      results.push({
        studentId: student._id,
        studentName,

        className,              // BASIC 9 (raw)
        classDisplayName,       // BASIC 9A (UI-safe)

        presentDays,
        amountPerDay,
        total,
        days,
        records,
        notification: notifMap[String(student._id)] || null,
      });
    }

    // 🔔 MARK NOTIFICATIONS AS READ
    await Notification.updateMany(
      {
        studentId: { $in: allStudentIds },
        type: "feedingfee",
        isRead: false,
        recipientUsers: user._id,
      },
      { $set: { isRead: true } }
    );

    // 🟢 RETURN PROPER RESPONSE FORMAT
    const responseData = {
      success: true,
      count: results.length,
      data: childId || results.length === 1 ? results[0] : results,
      week: weekNumber,
      term: termId,
      weekDates,
      configType: "class-based",
    };

    console.log(`✅ Returning feeding fee data for ${results.length} students`);
    return res.json(responseData);

  } catch (error) {
    console.error("❌ Error in getFeedingFeeForStudent:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching feeding fee data",
      error: error.message,
    });
  }
};

// --------------------------------------------------------------------
// 📈 Get feeding fee summary WITH CACHING
// --------------------------------------------------------------------
const getFeedingFeeSummary = async (req, res) => {
  try {
    const { classId, termId, week } = req.query;
    const schoolId = toObjectId(req.user.school);
    const normalizedWeek = week
      ? parseInt(String(week).replace(/Week\s*/i, ""), 10)
      : undefined;

    const feeConfig = await getFeeConfigWithCache(schoolId);
    if (!feeConfig) {
      return res
        .status(404)
        .json({ success: false, message: "Fee configuration not found" });
    }

    // Get students in the class
    const students = await Student.find({ class: toObjectId(classId) })
      .populate("class")
      .populate("user") || [];

    if (!students.length) {
      return res.json({
        success: true,
        totalAmount: 0,
        studentCount: 0,
        breakdown: [],
        message: "No students found in this class"
      });
    }

    const termDoc = await Term.findById(termId).lean();
    const weekBounds = getTargetWeekBounds(termDoc, normalizedWeek);

    // Fetch attendance and manual feeding records in parallel
    const [attendanceRecords, manualFeedingRecords] = await Promise.all([
      StudentAttendance.find({
        class: toObjectId(classId),
        ...(termId && { termId: toObjectId(termId) }),
        ...(normalizedWeek && { weekNumber: normalizedWeek })
      }).populate("student") || [],
      FeedingFeeRecord.find({
        classId: toObjectId(classId),
        ...(termId && { termId: toObjectId(termId) }) // TERM-WIDE SCAN FOR PHYSICAL CASH
      }) || []
    ]);

    // Map mathematical cash drawer flow
    const nativeManualAmountByStudent = new Map();
    const debtRecoveryAmountByStudent = new Map();

    const WEEK_DAY_KEYS = ["M", "T", "W", "TH", "F"];
    const dailyTotalsObj = { M: 0, T: 0, W: 0, TH: 0, F: 0 };
    const dailyCountsObj = { M: 0, T: 0, W: 0, TH: 0, F: 0 };

    for (const record of manualFeedingRecords) {
      if (!record.breakdown || !Array.isArray(record.breakdown)) continue;
      const isNativeRecord = record.week === normalizedWeek;

      for (const entry of record.breakdown) {
        if (!entry.student) continue;
        const sid = String(entry.student);

        const amountPerDay = resolveEntryAmountPerDay(entry, record, feeConfig);
        const resolvedAmount = amountPerDay > 0 ? amountPerDay : (Number(entry?.perDayFee?.['M']) || 0);

        if (resolvedAmount <= 0) continue;

        let nativeAmountCaptured = 0;
        let debtAmountCaptured = 0;

        for (const dayKey of WEEK_DAY_KEYS) {
          const isPaid = entry.days?.[dayKey] === 'present';
          if (!isPaid) continue;

          const paidAt = entry.paidAt?.[dayKey];

          if (!paidAt) {
            if (isNativeRecord) {
              nativeAmountCaptured += resolvedAmount;
              dailyTotalsObj[dayKey] += resolvedAmount;
              dailyCountsObj[dayKey] += 1;
            }
          } else {
            const paidDate = new Date(paidAt);
            if (paidDate >= weekBounds.windowStart && paidDate <= weekBounds.windowEnd) {
              if (isNativeRecord) nativeAmountCaptured += resolvedAmount;
              else debtAmountCaptured += resolvedAmount;
              
              // Map paidAt date to Day of Week
              const paymentDayOfWeek = paidDate.getDay();
              let mappedTab = 'M';
              if (paymentDayOfWeek === 2) mappedTab = 'T';
              else if (paymentDayOfWeek === 3) mappedTab = 'W';
              else if (paymentDayOfWeek === 4) mappedTab = 'TH';
              else if (paymentDayOfWeek === 5) mappedTab = 'F';
              
              dailyTotalsObj[mappedTab] += resolvedAmount;
              dailyCountsObj[mappedTab] += 1;
            }
          }
        }

        if (nativeAmountCaptured > 0) {
          const currentNative = nativeManualAmountByStudent.get(sid) || 0;
          nativeManualAmountByStudent.set(sid, currentNative + nativeAmountCaptured);
        }
        if (debtAmountCaptured > 0) {
          const currentDebt = debtRecoveryAmountByStudent.get(sid) || 0;
          debtRecoveryAmountByStudent.set(sid, currentDebt + debtAmountCaptured);
        }
      }
    }

    let totalAmount = 0;
    let studentCount = 0;
    const breakdown = [];

    for (const student of students) {
      const studentId = String(student._id);
      const amountPerDay = getAmountPerDay(student, feeConfig);

      const resolvedNativeAmount = nativeManualAmountByStudent.get(studentId) || 0;
      const debtAmount = debtRecoveryAmountByStudent.get(studentId) || 0;

      const studentTotal = resolvedNativeAmount + debtAmount;
      if (studentTotal === 0) continue;

      totalAmount += studentTotal;
      studentCount++;

      const { className, classDisplayName } = resolveClassNames(student.class);

      breakdown.push({
        studentId,
        studentName: getFullStudentName(student),
        className,
        classDisplayName,
        daysPaid: studentTotal / (amountPerDay || 1), // Logical days equivalent
        amountPerDay,
        total: studentTotal,
        isRecoveredDebt: debtAmount > 0
      });
    }

    // Format dailyTotals to match UI expectations
    const dailyTotals = WEEK_DAY_KEYS.map((key) => {
      let label = 'Mon';
      if (key === 'T') label = 'Tue';
      else if (key === 'W') label = 'Wed';
      else if (key === 'TH') label = 'Thu';
      else if (key === 'F') label = 'Fri';
      
      return {
        day: label,
        key: key,
        count: dailyCountsObj[key],
        amount: dailyTotalsObj[key]
      };
    });

    return res.json({
      success: true,
      totalAmount,
      studentCount,
      breakdown,
      dailyTotals,
      currency: feeConfig.currency || "GHS",
      configType: 'class-based'
    });
  } catch (err) {
    console.error("❌ Error in getFeedingFeeSummary:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to generate feeding fee summary",
      error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
};

// --------------------------------------------------------------------
// 🧹 Cache cleanup
// --------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();

  // Clean fee config cache
  for (const [key, value] of feeConfigCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      feeConfigCache.delete(key);
    }
  }

  // Clean class cache
  for (const [key, value] of classCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      classCache.delete(key);
    }
  }

  // Clean student cache
  for (const [key, value] of studentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      studentCache.delete(key);
    }
  }
}, CACHE_TTL);


// --------------------------------------------------------------------
// 🔍 Get Absentees for School/Week
// --------------------------------------------------------------------
const getAbsenteesForWeek = async (req, res) => {
  try {
    const { termId, week } = req.query;
    if (!termId || !week) {
      return res.status(400).json({ success: false, message: "Missing termId or week" });
    }

    const schoolId = req.user.school;
    const weekNumber = normalizeWeekNumber(week);

    // ONLY use StudentAttendance as the source of truth for physical school absentees.
    // A student can be present in school but not pay feeding fee — that student belongs
    // in the Debtors list, NOT the Absentees list.
    const attendanceRecords = await StudentAttendance.find({
      school: schoolId,
      termId,
      weekNumber
    })
      .populate({
        path: 'student',
        select: 'name firstName lastName user',
        populate: { path: 'user', select: 'name' }
      })
      .populate('class', 'name displayName')
      .lean();

    const absentees = [];

    for (const attRecord of attendanceRecords) {
      if (!attRecord.student) continue;

      const days = attRecord.days || {};
      const absentDays = [];

      // StudentAttendance schema uses M, T, W, TH, F directly
      for (const [dayKey, status] of Object.entries(days)) {
        if (status === 'absent') absentDays.push(dayKey);
      }

      if (absentDays.length > 0) {
        // Use getFullStudentName which resolves: user.name → name → firstName+lastName
        const studentName = getFullStudentName(attRecord.student);
        const cls = attRecord.class || {};

        absentees.push({
          studentId: attRecord.student._id || attRecord.student,
          studentName,
          classId: cls._id || attRecord.class,
          className: cls.displayName || cls.name || '',
          absentDays
        });
      }
    }

    return res.json({
      success: true,
      week: weekNumber,
      count: absentees.length,
      absentees
    });

  } catch (error) {
    console.error("Error fetching absentees:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch absentees" });
  }
};

// --------------------------------------------------------------------
// 🔍 Get Debtors for School/Term
// --------------------------------------------------------------------
const getDebtorsForWeek = async (req, res) => {
  try {
    const { termId } = req.query;
    if (!termId) {
      return res.status(400).json({ success: false, message: "Missing termId" });
    }

    const schoolId = req.user.school;

    // Fetch all FeedingFeeRecords AND all StudentAttendance records for the term in parallel
    const [records, attendanceRecords] = await Promise.all([
      FeedingFeeRecord.find({ school: schoolId, termId })
        .populate('breakdown.student', 'guardianName guardianPhone')
        .lean(),
      StudentAttendance.find({ school: schoolId, termId }).lean()
    ]);

    // Build a lookup: studentId + week -> { M: 'absent'|'present'|... }
    // This tells us what the Attendance page says about each student per week
    const attendanceLookup = new Map();
    for (const att of attendanceRecords) {
      const sid = String(att.student);
      const week = att.weekNumber;
      const key = `${sid}_${week}`;
      attendanceLookup.set(key, att.days || {});
    }

    const debtors = [];

    for (const record of records) {
      if (!record.breakdown) continue;

      for (const entry of record.breakdown) {
        const studentObj = entry.student || {};
        const studentId = String(studentObj._id || studentObj);
        const week = record.week;
        const attKey = `${studentId}_${week}`;
        const attDays = attendanceLookup.get(attKey) || {};

        const debtorDays = [];
        for (const day of ['M', 'T', 'W', 'TH', 'F']) {
          const feedingStatus = entry.days?.[day];
          const attendanceStatus = attDays[day];

          // A debtor is ONLY a student explicitly marked 'unpaid' from the Feeding Fee page.
          // 'absent' is reserved for attendance-synced physical absence and is NOT a debt.
          if (feedingStatus === 'unpaid') {
            debtorDays.push(day);
          }
        }

        if (debtorDays.length > 0) {
          debtors.push({
            studentId,
            studentName: entry.studentName,
            classId: record.classId,
            className: entry.className,
            week: record.week,
            debtorDays,
            guardianName: studentObj.guardianName || '',
            guardianPhone: studentObj.guardianPhone || ''
          });
        }
      }
    }

    return res.json({
      success: true,
      count: debtors.length,
      debtors
    });

  } catch (error) {
    console.error("Error fetching debtors:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch debtors" });
  }
};

// Get daily totals across ALL classes for the selected week
const getDailyTotalSummary = async (req, res) => {
  try {
    const { termId, week } = req.query;
    const schoolId = req.user.school;

    if (!termId || !week) {
      return res.status(400).json({ message: 'Missing termId or week' });
    }

    const weekNumber = normalizeWeekNumber(week);

    const termDoc = await Term.findById(termId).lean();
    if (!termDoc) {
      return res.status(404).json({ message: 'Term not found' });
    }

    const feeConfig = await getFeeConfigWithCache(schoolId);
    if (!feeConfig) {
      return res.status(404).json({ message: 'Fee configuration not found' });
    }

    const weekBounds = getTargetWeekBounds(termDoc, weekNumber);

    // Find records for ALL classes in this school for this term (term-wide scanning)
    const records = await FeedingFeeRecord.find({
      school: schoolId,
      termId
    })
      .populate({
        path: 'breakdown.student',
        select: 'name firstName lastName class user',
        populate: {
          path: 'class',
          select: 'name displayName level'
        }
      })
      .populate('classId', 'name displayName level')
      .lean();

    const totals = { M: 0, T: 0, W: 0, TH: 0, F: 0 };

    for (const record of records) {
      if (!record.breakdown) continue;
      for (const entry of record.breakdown) {
        const isNativeRecord = record.week === weekNumber;
        const amountPerDay = resolveEntryAmountPerDay(entry, record, feeConfig);
        const resolvedAmount = amountPerDay > 0 ? amountPerDay : (Number(entry?.perDayFee?.['M']) || 0);

        if (resolvedAmount <= 0) continue;

        for (const dayKey of WEEK_DAY_KEYS) {
          const isPaid = entry.days?.[dayKey] === 'present';
          if (!isPaid) continue;

          const paidAt = entry.paidAt?.[dayKey];

          if (!paidAt) {
            if (isNativeRecord) {
              totals[dayKey] += resolvedAmount;
            }
          } else {
            const paidDate = new Date(paidAt);
            if (paidDate >= weekBounds.windowStart && paidDate <= weekBounds.windowEnd) {
              const paymentDayOfWeek = paidDate.getDay();
              let mappedTab = 'M';
              if (paymentDayOfWeek === 2) mappedTab = 'T';
              else if (paymentDayOfWeek === 3) mappedTab = 'W';
              else if (paymentDayOfWeek === 4) mappedTab = 'TH';
              else if (paymentDayOfWeek === 5) mappedTab = 'F';

              totals[mappedTab] += resolvedAmount;
            }
          }
        }
      }
    }

    const grandTotal = totals.M + totals.T + totals.W + totals.TH + totals.F;

    res.json({
      success: true,
      totals,
      grandTotal
    });

  } catch (error) {
    console.error('Error fetching daily totals:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// --------------------------------------------------------------------
// 📋 Get Daily Feeding Fee Audit Report
// --------------------------------------------------------------------
const getTargetWeekBounds = (termDoc, weekNumber) => {
  const startDate = new Date(termDoc.startDate);
  startDate.setHours(0, 0, 0, 0);
  const weekStart = new Date(startDate);
  weekStart.setDate(startDate.getDate() + (weekNumber - 1) * 7);

  const windowStart = new Date(weekStart);
  windowStart.setDate(windowStart.getDate() - 2); // Expand to previous weekend

  const windowEnd = new Date(weekStart);
  windowEnd.setDate(windowStart.getDate() + 8); // Cover the whole week up to next weekend

  return { windowStart, windowEnd };
};

const getFeedingFeeAuditReport = async (req, res) => {
  try {
    const { termId, week, day } = req.query;
    const schoolId = req.user.school;

    if (!termId || !week || !day) {
      return res.status(400).json({ success: false, message: "Missing termId, week, or day" });
    }

    const weekNumber = normalizeWeekNumber(week);

    const termDoc = await Term.findById(termId).lean();
    if (!termDoc) {
      return res.status(404).json({ success: false, message: "Term not found" });
    }

    const feeConfig = await getFeeConfigWithCache(schoolId);
    if (!feeConfig) {
      return res.status(404).json({ success: false, message: "Fee configuration not found" });
    }

    const weekDates = getWeekDayDates(termDoc, weekNumber);
    const weekBounds = getTargetWeekBounds(termDoc, weekNumber);

    // Fetch ALL records for the school/term to capture cross-week Debt Recoveries
    const records = await FeedingFeeRecord.find({
      school: schoolId,
      termId
    })
      .populate({
        path: 'breakdown.student',
        select: 'guardianName guardianPhone name firstName lastName class user',
        populate: {
          path: 'class',
          select: 'name displayName level'
        }
      })
      .populate('classId', 'name displayName level')
      .lean();

    const auditReport = [];
    let grandTotal = 0;
    let totalPaid = 0;
    let totalUnpaid = 0;

    for (const record of records) {
      if (!record.breakdown || record.breakdown.length === 0) continue;

      const classId = record.classId?._id || record.classId;
      const className = record.classId?.displayName || record.classId?.name || 'Unknown Class';

      let classTotalAmount = 0;
      let classPaidCount = 0;
      let classUnpaidCount = 0;
      const studentsDetails = [];

      for (const entry of record.breakdown) {
        const isNativeRecord = record.week === weekNumber;
        const amountPerDay = resolveEntryAmountPerDay(entry, record, feeConfig);
        const resolvedAmount = amountPerDay > 0 ? amountPerDay : (Number(entry?.perDayFee?.['M']) || 0);

        if (resolvedAmount <= 0) continue;

        let amountPaidToday = 0;
        const recoveredDays = [];
        const FULL_DAY_NAMES = { "M": "Monday", "T": "Tuesday", "W": "Wednesday", "TH": "Thursday", "F": "Friday" };

        for (const dayKey of WEEK_DAY_KEYS) {
          const isPaidDay = entry.days?.[dayKey] === 'present';
          if (!isPaidDay) continue;

          const paidAt = entry.paidAt?.[dayKey];

          if (!paidAt) {
            if (isNativeRecord && dayKey === day) {
              amountPaidToday += resolvedAmount;
            }
          } else {
            const paidDate = new Date(paidAt);
            if (paidDate >= weekBounds.windowStart && paidDate <= weekBounds.windowEnd) {
              const paymentDayOfWeek = paidDate.getDay();
              let mappedTab = 'M';
              if (paymentDayOfWeek === 2) mappedTab = 'T';
              else if (paymentDayOfWeek === 3) mappedTab = 'W';
              else if (paymentDayOfWeek === 4) mappedTab = 'TH';
              else if (paymentDayOfWeek === 5) mappedTab = 'F';

              if (mappedTab === day) {
                amountPaidToday += resolvedAmount;
                if (!isNativeRecord) {
                  recoveredDays.push(FULL_DAY_NAMES[dayKey]);
                }
              }
            }
          }
        }

        // Include native records ALWAYS. Include non-native ONLY if they contributed cash today.
        if (!isNativeRecord && amountPaidToday === 0) continue;

        const isPaid = amountPaidToday > 0;

        if (isNativeRecord) {
          if (isPaid) {
            classPaidCount++; totalPaid++; classTotalAmount += amountPaidToday; grandTotal += amountPaidToday;
          } else {
            const nativeDayStatus = entry.days?.[day];
            if (nativeDayStatus === 'notmarked' || nativeDayStatus === 'present' || nativeDayStatus === 'absent') {
              classUnpaidCount++; totalUnpaid++;
            }
          }
        } else {
          // Debt recovery injection
          classPaidCount++; totalPaid++; classTotalAmount += amountPaidToday; grandTotal += amountPaidToday;
        }

        const studentObj = entry.student || {};
        let nativeStatus = 'notmarked';
        if (isNativeRecord) {
          nativeStatus = entry.days?.[day] || 'notmarked';
        } else {
          const joinedDays = recoveredDays.length > 0 ? `, ${recoveredDays.join(' & ')}` : '';
          nativeStatus = `Debt Recovery (Week ${record.week}${joinedDays})`;
        }

        studentsDetails.push({
          studentId: studentObj._id || entry.student,
          studentName: entry.studentName,
          status: nativeStatus,
          amount: amountPaidToday,
          isRecoveredDebt: !isNativeRecord,
          guardianName: studentObj.guardianName || '',
          guardianPhone: studentObj.guardianPhone || ''
        });
      }

      // Sort students alphabetically
      studentsDetails.sort((a, b) => {
        if (!a.studentName) return 1;
        if (!b.studentName) return -1;
        return a.studentName.localeCompare(b.studentName);
      });

      auditReport.push({
        classId,
        className,
        totalAmount: classTotalAmount,
        paidCount: classPaidCount,
        unpaidCount: classUnpaidCount,
        students: studentsDetails
      });
    }

    // Sort classes alphabetically
    auditReport.sort((a, b) => {
      if (!a.className) return 1;
      if (!b.className) return -1;
      return a.className.localeCompare(b.className);
    });

    return res.json({
      success: true,
      day,
      week: weekNumber,
      grandTotal,
      totalPaid,
      totalUnpaid,
      report: auditReport
    });

  } catch (error) {
    console.error("Error fetching audit report:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch audit report", error: error.message });
  }
};

module.exports = {
  markFeeding,
  processFeedingJob, // Added processFeedingJob
  calculateFeedingFeeCollection,
  getFeedingFeeConfig,
  setFeedingFeeConfig,
  getClassesWithFeeBands,
  getFeedingFeeForStudent,
  getFeedingFeeSummary,
  getAbsenteesForWeek,
  getDebtorsForWeek,
  getDailyTotalSummary,
  getFeedingFeeAuditReport
};