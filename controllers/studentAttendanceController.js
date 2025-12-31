// StudentAttendanceController.js - OPTIMIZED VERSION (No External Dependencies)
const StudentAttendance = require('../models/StudentAttendance');
const Student = require('../models/Student');
const Term = require("../models/term");
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const FeedingFeeConfig = require('../models/FeedingFeeConfig');
const Class = require('../models/Class');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const { getAmountPerDay } = require('../utils/feedingFeeUtils');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();


// 🔔 Push notification helper
async function sendPush(userIds, title, body, extraData = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false,
  }).lean();

  const validTokens = tokens
    .map(t => t.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (!validTokens.length) return;

  const messages = validTokens.map(token => ({
    to: token,
    title,
    body,
    sound: "default",
    data: { type: "attendance", ...extraData }
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error("⚠️ Push send error:", err);
    }
  }
}


// ==============================
// Helper: Normalize class display name
// ==============================
function getClassDisplayName(cls) {
  if (!cls) return "Unknown Class";

  if (cls.displayName && cls.displayName.trim()) {
    return cls.displayName;
  }

  if (cls.classDisplayName && cls.classDisplayName.trim()) {
    return cls.classDisplayName;
  }

  if (cls.name && cls.stream) {
    return `${cls.name}${cls.stream}`;
  }

  return cls.name || "Unknown Class";
}

// 🎯 SIMPLE IN-MEMORY CACHE (No external dependencies)
class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.defaultTTL = 300000; // 5 minutes in milliseconds
  }

  set(key, value, ttl = this.defaultTTL) {
    this.cache.set(key, {
      value,
      expires: Date.now() + ttl
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }

  del(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Clean up expired items (optional - call periodically)
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expires) {
        this.cache.delete(key);
      }
    }
  }
}

const cache = new SimpleCache();

// -------------------- Cache Keys & Helper Utilities --------------------
const CACHE_KEYS = {
  CLASS: (id) => `class:${id}`,
  TERM: (id, schoolId) => `term:${id}:${schoolId}`,
  STUDENTS_BY_CLASS: (classId, schoolId) => `students:class:${classId}:${schoolId}`,
  FEE_CONFIG: (schoolId) => `feeConfig:${schoolId}`,
  DAILY_BREAKDOWN: (classId, termId, week) => `daily:${classId}:${termId}:${week}`,
  WEEKLY_SUMMARY: (classId, termId, week) => `weekly:${classId}:${termId}:${week}`
};

const DEFAULT_DAYS = { M: 'notmarked', T: 'notmarked', W: 'notmarked', TH: 'notmarked', F: 'notmarked' };

// 🎯 DATABASE OPTIMIZATIONS - Lean queries & proper indexing
const normalizeWeek = (week) => {
  if (week === undefined || week === null) return null;
  
  if (typeof week === 'number' && !isNaN(week)) return Number(week);
  
  if (typeof week === 'string') {
    const numMatch = week.match(/\d+/);
    if (numMatch) return parseInt(numMatch[0], 10);
    const n = Number(week);
    if (!Number.isNaN(n)) return n;
  }
  
  return null;
};

const getWeekStartDate = (term, weekNumber) => {
  const startDate = new Date(term.startDate);
  const weekStart = new Date(startDate);
  weekStart.setDate(startDate.getDate() + (Number(weekNumber) - 1) * 7);
  return weekStart;
};

function inferCategoryFromClassName(name = '') {
  const n = (name || '').toLowerCase();
  if (n.includes('nursery') || n.includes('kg')) return 'nursery-kg';
  if (n.includes('basic') || n.includes('primary')) return 'basic1-6';
  if (n.includes('jhs') || n.includes('junior')) return 'jhs';
  return 'general';
}

// 🎯 PARALLEL OPERATIONS - Optimized data fetching
const fetchCriticalData = async (schoolId, classId, termId, userId) => {
  const [classDoc, term, feeConfig, classStudents] = await Promise.all([
    // 🎯 CACHED CLASS QUERY
    (async () => {
      const cacheKey = CACHE_KEYS.CLASS(classId);
      let classDoc = cache.get(cacheKey);
      if (!classDoc) {
        classDoc = await Class.findById(classId).lean();
        if (classDoc) cache.set(cacheKey, classDoc);
      }
      return classDoc;
    })(),
    
    // 🎯 CACHED TERM QUERY
    (async () => {
      const cacheKey = CACHE_KEYS.TERM(termId, schoolId);
      let term = cache.get(cacheKey);
      if (!term) {
        term = await Term.findOne({ _id: termId, school: schoolId }).lean();
        if (term) cache.set(cacheKey, term);
      }
      return term;
    })(),
    
    // 🎯 CACHED FEE CONFIG QUERY
    (async () => {
      const cacheKey = CACHE_KEYS.FEE_CONFIG(schoolId);
      let feeConfig = cache.get(cacheKey);
      if (!feeConfig) {
        feeConfig = await FeedingFeeConfig.findOne({ school: schoolId }).lean();
        if (feeConfig) cache.set(cacheKey, feeConfig);
      }
      return feeConfig;
    })(),
    
    // 🎯 CACHED STUDENTS QUERY WITH LEAN & PROJECTION
    (async () => {
      const cacheKey = CACHE_KEYS.STUDENTS_BY_CLASS(classId, schoolId);
      let students = cache.get(cacheKey);
      if (!students) {
        students = await Student.find({ class: classId, school: schoolId })
          .select('_id class parent parentIds user')
          .populate('class', 'name level')
          .populate('user', 'name')
          .lean();
        if (students.length > 0) cache.set(cacheKey, students);
      }
      return students;
    })()
  ]);

  return { classDoc, term, feeConfig, classStudents };
};

// 🎯 BACKGROUND PROCESSING - Non-blocking notifications
const sendNotificationsInBackground = async (changedStudents, schoolId, classId, termId, weekNumber, userId) => {
  setImmediate(async () => {
    try {
      if (changedStudents.size === 0) return;

      const changed = Array.from(changedStudents);

      const affectedStudents = await Student.aggregate([
        { 
          $match: { 
            _id: { $in: changed.map(id => new mongoose.Types.ObjectId(id)) },
            school: new mongoose.Types.ObjectId(schoolId)
          } 
        },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'user'
          }
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            'user.name': 1,
            'user._id': 1,
            parent: 1,
            parentIds: 1
          }
        }
      ]);

      const bulkOps = [];
      const pushTargets = [];

      for (const stu of affectedStudents) {

        const parentRecipients = new Set();

        if (stu.parent) parentRecipients.add(String(stu.parent));
        if (Array.isArray(stu.parentIds)) {
          stu.parentIds.forEach(p => parentRecipients.add(String(p._id || p)));
        }

        // PARENT NOTIFICATION
        if (parentRecipients.size > 0) {
          const userList = [...parentRecipients];

          bulkOps.push({
            insertOne: {
              document: {
                sender: userId,
                school: schoolId,
                title: "Attendance Updated",
                message: `Attendance has been updated for ${stu.user?.name || "your child"}.`,
                type: "attendance",
                audience: "parent",
                recipientRoles: ["parent"],
                recipientUsers: userList,
                class: classId,
                studentId: stu._id,
                termId,
                week: weekNumber,
                createdAt: new Date()
              }
            }
          });

          // PUSH → Parents
          pushTargets.push({ users: userList, name: stu.user?.name });
        }

        // STUDENT NOTIFICATION
        if (stu.user?._id) {
          const sid = String(stu.user._id);

          bulkOps.push({
            insertOne: {
              document: {
                sender: userId,
                school: schoolId,
                title: "Attendance Updated",
                message: `Your attendance for week ${weekNumber} has been updated.`,
                type: "attendance",
                audience: "student",
                recipientRoles: ["student"],
                recipientUsers: [sid],
                class: classId,
                studentId: stu._id,
                termId,
                week: weekNumber,
                createdAt: new Date()
              }
            }
          });

          // PUSH → Student
          pushTargets.push({ users: [sid], name: stu.user?.name });
        }
      }

      // BULK SAVE
      if (bulkOps.length > 0) {
        await Notification.bulkWrite(bulkOps);
      }

      // SEND PUSH MESSAGES
      for (const target of pushTargets) {
        await sendPush(
          target.users,
          "Attendance Updated",
          `Attendance updated for ${target.name}.`,
          { weekNumber, classId, termId }
        );
      }

      console.log(`🔔 Attendance notifications + push sent for ${changed.length} students`);

    } catch (error) {
      console.error('⚠️ Background notification error:', error);
    }
  });
};


// -------------------- Mark Attendance - OPTIMIZED --------------------
const markAttendance = async (req, res) => {
  console.log('📝 markAttendance payload:', req.body);
  const { attendanceUpdates, week, weekNumber: weekParam, termId, classId } = req.body;
  const userId = req.user._id;
  const userRole = req.user.role;
  const schoolId = req.user.school;

  if (!Array.isArray(attendanceUpdates) || attendanceUpdates.length === 0) {
    return res.status(400).json({ message: 'attendanceUpdates must be a non-empty array.' });
  }

  // 🎯 EARLY VALIDATION
  if (!classId || !termId) {
    return res.status(400).json({ message: 'Missing classId or termId' });
  }

  try {
    const { classDoc, term, feeConfig, classStudents } = await fetchCriticalData(schoolId, classId, termId, userId);

    if (!classDoc) return res.status(404).json({ message: 'Class not found' });
    if (!term) return res.status(404).json({ message: 'Term not found' });

    if (userRole === 'teacher' && String(classDoc.classTeacher) !== String(userId)) {
      return res.status(403).json({ message: 'Only the assigned class teacher can mark attendance' });
    }

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid or missing week/weekNumber' });

    const weekString = String(weekParam ?? week ?? weekNumber);
    const weekStartDate = getWeekStartDate(term, weekNumber);
    const category =
  classDoc.category ||
  inferCategoryFromClassName(getClassDisplayName(classDoc));


    // 🎯 TRANSACTION SAFETY - MongoDB session for critical operations
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let feedingRecord = await FeedingFeeRecord.findOne({
        school: schoolId,
        classId: classId,
        termId: termId,
        week: weekNumber
      }).session(session);

      if (!feedingRecord) {
        feedingRecord = new FeedingFeeRecord({
          school: schoolId,
          classId: classId,
          termId: termId,
          week: weekNumber,
          weekNumber,
          category,
          breakdown: [],
          totalCollected: 0,
          collectedBy: userId,
          date: weekStartDate
        });
      }

      const changedStudents = new Set();
      const studentMap = new Map(classStudents.map(s => [String(s._id), s]));

      // 🎯 BULK OPERATION PREPARATION
      const bulkAttendanceOps = [];
      const studentIdsToUpdate = new Set();

      // 🎯 OPTIMIZED ATTENDANCE PROCESSING
      for (const update of attendanceUpdates) {
        const studentId = update.studentId || update.student;
        const { days } = update;
        if (!studentId || !days) continue;

        const student = studentMap.get(String(studentId));
        if (!student) continue;

        studentIdsToUpdate.add(studentId);
      }

      // 🎯 PARALLEL OPERATIONS - Fetch existing attendance in batch
      const existingAttendances = await StudentAttendance.find({
        student: { $in: Array.from(studentIdsToUpdate) },
        class: classId,
        weekNumber,
        termId: termId,
        school: schoolId
      }).session(session).lean();

      const attendanceMap = new Map();
      existingAttendances.forEach(record => {
        attendanceMap.set(String(record.student), record);
      });

      // Process updates
      for (const update of attendanceUpdates) {
        const studentId = update.studentId || update.student;
        const { days } = update;
        if (!studentId || !days) continue;

        const student = studentMap.get(String(studentId));
        if (!student) continue;

        const existingAttendance = attendanceMap.get(String(studentId));
        const attendanceData = {
          days: existingAttendance ? { ...existingAttendance.days } : { ...DEFAULT_DAYS },
          totalPresent: 0,
          week: weekString,
          weekNumber,
          weekStartDate,
          termId: termId,
          updatedBy: userId,
          updatedAt: new Date()
        };

        const changedDays = new Set();
        for (const [dayKey, status] of Object.entries(days)) {
          if (!['M', 'T', 'W', 'TH', 'F'].includes(dayKey)) continue;
          if (!['present', 'absent'].includes(status)) continue;

          if (attendanceData.days[dayKey] !== status) {
            changedDays.add(dayKey);
            attendanceData.days[dayKey] = status;
          }
        }

        attendanceData.totalPresent = Object.values(attendanceData.days)
          .filter(v => v === 'present').length;

        if (changedDays.size > 0) {
          changedStudents.add(String(studentId));

          bulkAttendanceOps.push({
            updateOne: {
              filter: { 
                student: studentId, 
                class: classId, 
                weekNumber, 
                termId: termId, 
                school: schoolId 
              },
              update: { 
                $set: { 
                  ...attendanceData, 
                  school: schoolId,
                  class: classId
                } 
              },
              upsert: true
            }
          });
        }

        // Feeding sync optimization
        if (changedDays.size > 0) {
          const amountPerDay = getAmountPerDay(student, feeConfig || {});
          const fedDays = Object.entries(attendanceData.days)
            .filter(([_, status]) => status === 'present')
            .map(([key]) => key);

          const existingStudentEntry = feedingRecord.breakdown
            .find(b => String(b.student) === String(studentId));

          if (!existingStudentEntry) {
            feedingRecord.breakdown.push({
              student: studentId,
              studentName: student.user?.name || "Student",
              className: getClassDisplayName(classDoc),
              daysPaid: fedDays.length,
              days: Object.fromEntries(
                Object.entries(DEFAULT_DAYS).map(([key]) => [
                  key,
                  fedDays.includes(key) ? 'present' : 'absent'
                ])
              ),
              amountPerDay,
              total: fedDays.length * amountPerDay,
              source: 'attendance-sync'
            });
          } else {
            for (const [key] of Object.entries(DEFAULT_DAYS)) {
              if (fedDays.includes(key)) existingStudentEntry.days[key] = 'present';
              else if (changedDays.has(key)) existingStudentEntry.days[key] = 'absent';
            }
            existingStudentEntry.daysPaid = fedDays.length;
            existingStudentEntry.total = fedDays.length * amountPerDay;
          }
        }
      }

      // 🎯 BULK WRITE OPERATION
      if (bulkAttendanceOps.length > 0) {
        await StudentAttendance.bulkWrite(bulkAttendanceOps, { session });
      }

      // Recalculate class total
      feedingRecord.totalCollected = feedingRecord.breakdown
        .reduce((sum, b) => sum + (b.total || 0), 0);

      await feedingRecord.save({ session });

      await session.commitTransaction();

      // 🎯 CACHE INVALIDATION
      cache.del(CACHE_KEYS.DAILY_BREAKDOWN(classId, termId, weekNumber));
      cache.del(CACHE_KEYS.WEEKLY_SUMMARY(classId, termId, weekNumber));

      // 🎯 BACKGROUND PROCESSING - Non-blocking notifications
      sendNotificationsInBackground(changedStudents, schoolId, classId, termId, weekNumber, userId);

      res.json({
        success: true,
        message: `Processed ${attendanceUpdates.length} students successfully`,
        week: weekString,
        weekNumber,
        updated: changedStudents.size
      });

    } catch (err) {
      await session.abortTransaction();
      console.error('💥 markAttendance transaction error:', err);
      throw err;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('⚠️ Attendance Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Attendance processing failed', 
      error: error.message 
    });
  }
};

// -------------------- getDailyBreakdown - OPTIMIZED --------------------
const getDailyBreakdown = async (req, res) => {
  const { classId, week, weekNumber: weekParam, termId } = req.query;
  
  if (!classId || (!week && !weekParam) || !termId) {
    return res.status(400).json({ message: 'Missing required query params' });
  }

  try {
    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    // 🎯 CACHE LAYER - Check cache first
    const cacheKey = CACHE_KEYS.DAILY_BREAKDOWN(classId, termId, weekNumber);
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 🎯 DATABASE OPTIMIZATIONS - Aggregation pipeline for better performance
    const result = await Student.aggregate([
      {
        $match: {
          class: new mongoose.Types.ObjectId(classId),
          school: new mongoose.Types.ObjectId(req.user.school)
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'studentattendances',
          let: { studentId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$student', '$$studentId'] },
                    { $eq: ['$class', new mongoose.Types.ObjectId(classId)] },
                    { $eq: ['$termId', new mongoose.Types.ObjectId(termId)] },
                    { $eq: ['$weekNumber', weekNumber] },
                    { $eq: ['$school', new mongoose.Types.ObjectId(req.user.school)] }
                  ]
                }
              }
            }
          ],
          as: 'attendance'
        }
      },
      {
        $project: {
          studentId: '$_id',
          name: '$user.name',
          days: {
            $ifNull: [{ $arrayElemAt: ['$attendance.days', 0] }, { ...DEFAULT_DAYS }]
          },
          week: { $literal: String(weekParam ?? week ?? weekNumber) },
          weekNumber: { $literal: weekNumber }
        }
      }
    ]);

    // 🎯 CACHE LAYER - Store result
    cache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('❌ getDailyBreakdown error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch daily breakdown', 
      error: error.message 
    });
  }
};

// -------------------- getWeeklySummary - OPTIMIZED --------------------
const getWeeklySummary = async (req, res) => {
  const { week, weekNumber: weekParam, termId, classId } = req.query;
  
  try {
    if (!termId) return res.status(400).json({ message: 'Missing termId' });

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    // 🎯 CACHE LAYER - Check cache first
    const cacheKey = CACHE_KEYS.WEEKLY_SUMMARY(classId, termId, weekNumber);
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 🎯 DATABASE OPTIMIZATIONS - Lean query with projection
    const summary = await StudentAttendance.find({
      school: req.user.school,
      class: classId,
      termId: termId,
      weekNumber
    })
    .select('student days totalPresent weekNumber')
    .populate('student', 'name')
    .lean();

    const result = { 
      week: String(weekParam ?? week ?? weekNumber), 
      weekNumber, 
      summary 
    };

    // 🎯 CACHE LAYER - Store result
    cache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('❌ getWeeklySummary error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch weekly summary', 
      error: error.message 
    });
  }
};

// -------------------- getStudentTermAttendance - OPTIMIZED --------------------
const getStudentTermAttendance = async (req, res) => {
  const { studentId, termId } = req.query;
  
  try {
    if (!termId) return res.status(400).json({ message: 'Missing termId' });
    if (!studentId) return res.status(400).json({ message: 'Missing studentId' });

    // 🎯 DATABASE OPTIMIZATIONS - Lean query with projection
    const records = await StudentAttendance.find({
      student: studentId,
      termId: termId,
      school: req.user.school
    })
    .select('weekNumber days totalPresent weekStartDate')
    .lean();

    res.json(records);
  } catch (error) {
    console.error('❌ getStudentTermAttendance error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch student term attendance', 
      error: error.message 
    });
  }
};

// -------------------- getStudentTermTotalAttendance --------------------
const getStudentTermTotalAttendance = async (req, res) => {
  try {
    const { studentId, termId } = req.query;
    const schoolId = req.user.school;

    if (!studentId || !termId) {
      return res.status(400).json({
        message: "studentId and termId are required"
      });
    }

    // 🎯 Single optimized aggregation
    const result = await StudentAttendance.aggregate([
      {
        $match: {
          student: new mongoose.Types.ObjectId(studentId),
          termId: new mongoose.Types.ObjectId(termId),
          school: new mongoose.Types.ObjectId(schoolId)
        }
      },
      {
        $group: {
          _id: "$student",
          totalAttendance: { $sum: "$totalPresent" }
        }
      }
    ]);

    res.json({
      success: true,
      studentId,
      termId,
      totalAttendance: result[0]?.totalAttendance || 0
    });

  } catch (error) {
    console.error("❌ getStudentTermTotalAttendance error:", error);
    res.status(500).json({
      message: "Failed to fetch student term attendance",
      error: error.message
    });
  }
};



// -------------------- initializeWeek - OPTIMIZED --------------------
const initializeWeek = async (req, res) => {
  try {
    const { classId, termId, week, weekNumber: weekParam } = req.body;
    const schoolId = req.user?.school?._id || req.user?.school?.id || req.user?.school;
    const userId = req.user._id;
    const userRole = req.user.role;

    if (!classId || !termId) return res.status(400).json({ message: 'Missing classId or termId' });

    if (!['admin', 'teacher'].includes(userRole)) {
      return res.status(403).json({ message: 'Only admins or class teachers can initialize a week' });
    }

    // 🎯 CACHED CLASS QUERY
    const classDoc = await Class.findById(classId);
    if (!classDoc) return res.status(404).json({ message: 'Class not found' });

    if (userRole === 'teacher' && String(classDoc.classTeacher) !== String(userId)) {
      return res.status(403).json({ message: 'Only the assigned class teacher can initialize this class week' });
    }

    // 🎯 CACHED TERM QUERY
    const term = await Term.findOne({ _id: termId, school: schoolId });
    if (!term) return res.status(404).json({ message: 'Term not found' });

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week parameter' });

    const existing = await StudentAttendance.findOne({
      school: schoolId,
      class: classId,
      termId,
      weekNumber
    });

    if (existing) {
      return res.status(200).json({
        message: `Week ${weekNumber} already initialized for this class.`,
        alreadyInitialized: true
      });
    }

    // 🎯 DATABASE OPTIMIZATIONS - Lean query for students
    const students = await Student.find({ class: classId, school: schoolId })
      .select('_id class')
      .lean();
      
    if (!students.length) return res.status(400).json({ message: 'No students found for this class' });

    const weekStartDate = getWeekStartDate(term, weekNumber);
    const weekString = String(weekParam ?? week ?? weekNumber);

    const attendanceRecords = students.map(student => ({
      student: student._id,
      class: classId,
      school: schoolId,
      termId,
      week: weekString,
      weekNumber,
      weekStartDate,
      days: { ...DEFAULT_DAYS },
      totalPresent: 0,
      createdBy: userId,
      createdAt: new Date(),
      initializer: { id: userId, role: userRole }
    }));

    // 🎯 BULK INSERT OPTIMIZATION
    await StudentAttendance.insertMany(attendanceRecords);

    // 🎯 CACHE INVALIDATION
    cache.del(CACHE_KEYS.STUDENTS_BY_CLASS(classId, schoolId));

// 🎯 BACKGROUND PROCESSING - Non-blocking notification
setImmediate(async () => {
  try {
    // Notify only teachers in that school
    const teacherUsers = await Class.findById(classId)
      .populate("teachers", "user")
      .lean();

    const teacherUserIds = [];

    if (teacherUsers?.teachers) {
      teacherUsers.teachers.forEach(t => {
        if (t.user?._id) teacherUserIds.push(String(t.user._id));
      });
    }

    await Notification.create({
      sender: req.user._id,
      school: req.user.school,
      title: "Attendance Week Initialized",
      message: `Attendance week ${weekNumber} initialized for ${getClassDisplayName(classDoc)}`,
      type: "attendance",
      audience: "teacher",
      class: classId,
      recipientRoles: ["teacher"],
      recipientUsers: teacherUserIds
    });

    // SEND PUSH
    await sendPush(
      teacherUserIds,
      "Attendance Week Initialized",
    `Week ${weekNumber} has been set up for ${getClassDisplayName(classDoc)}.`
    );

  } catch (error) {
    console.error('⚠️ Background notification error:', error);
  }
});


    res.status(200).json({
      success: true,
      message: `Week ${weekNumber} initialized successfully!`,
      week: weekString,
      weekNumber,
      studentsInitialized: attendanceRecords.length
    });

  } catch (err) {
    console.error('❌ Error initializing week:', err);
    res.status(500).json({
      message: 'Failed to initialize week',
      error: err.message
    });
  }
};

// -------------------- getWeeklyAttendance - OPTIMIZED --------------------
const getWeeklyAttendance = async (req, res) => {
  const { classId } = req.params;
  const { termId, week, weekNumber: weekParam } = req.query;
  
  if (!classId || !termId || (!week && !weekParam)) {
    return res.status(400).json({ message: 'Missing required parameters' });
  }

  try {
    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    // 🎯 DATABASE OPTIMIZATIONS - Lean query with optimized population
    const records = await StudentAttendance.find({
      school: req.user.school,
      class: classId,
      weekNumber,
      termId
    })
    .populate('student', 'name user')
    .lean();

    res.json({ 
      week: String(weekParam ?? week ?? weekNumber), 
      weekNumber, 
      records 
    });
  } catch (err) {
    console.error('❌ Failed to fetch weekly attendance:', err);
    res.status(500).json({ 
      message: 'Failed to fetch weekly attendance', 
      error: err.message 
    });
  }
};

// -------------------- getMyAttendance - OPTIMIZED --------------------
const getMyAttendance = async (req, res) => {
  try {
    const termId = req.query.termId || req.body.termId;
    const rawWeek = req.query.weekNumber || req.body.weekNumber || req.query.week || req.body.week;
    const weekNumber = normalizeWeek(rawWeek);
    const studentId = req.query.studentId || req.body.studentId;
    const childId = req.query.childId || req.body.childId;
    const schoolId = req.user.school;

    if (!termId) {
      return res.status(400).json({ message: "Missing termId (expected in query or body)" });
    }

    let targetStudent;

    // 🎯 OPTIMIZED STUDENT RESOLUTION WITH LEAN QUERIES
    if (req.user.role === "student") {
      targetStudent = await Student.findOne({
        $or: [{ user: req.user._id }, { _id: req.user._id }],
        school: schoolId,
      }).select('_id name class user').lean();

    } else if (req.user.role === "parent") {
      const targetId = childId || studentId;
      if (!targetId) {
        return res.status(400).json({
          message: "Missing childId or studentId for parent request",
        });
      }

      targetStudent = await Student.findOne({
        _id: targetId,
        school: schoolId,
        $or: [
          { parent: req.user._id },
          { parentIds: { $in: [req.user._id] } },
        ],
      }).select('_id name class user').lean();

      if (!targetStudent) {
        return res.status(403).json({
          message: "Unauthorized: This child is not linked to your parent account.",
        });
      }

    } else if (["teacher", "admin"].includes(req.user.role)) {
      if (!studentId) {
        return res.status(400).json({
          message: "Missing studentId for teacher/admin request",
        });
      }

      targetStudent = await Student.findOne({
        _id: studentId,
        school: schoolId,
      }).select('_id name class user').lean();
    }

    if (!targetStudent) {
      return res.status(404).json({ message: "Student record not found" });
    }

    // 🎯 CACHED TERM QUERY
    const term = await Term.findById(termId).lean();
    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    const selectedWeekNumber = weekNumber || term.weekNumber || 1;
    const weekString = `Week ${selectedWeekNumber}`;
    const selectedWeekStart = term.weekStartDate || getWeekStartDate(term, selectedWeekNumber);

    // 🎯 DATABASE OPTIMIZATIONS - Lean query with projection
    let records = await StudentAttendance.find({
      $or: [
        { student: targetStudent._id },
        { studentId: targetStudent._id },
      ],
      termId,
      school: schoolId,
    })
    .select('week weekNumber weekStartDate days totalPresent')
    .sort({ weekNumber: 1 })
    .lean();

    // Create default record if none exists
    if (!records || records.length === 0) {
      const newRecord = new StudentAttendance({
        student: targetStudent._id,
        studentId: targetStudent._id,
        school: schoolId,
        class: targetStudent.class,
        termId,
        week: weekString,
        weekNumber: selectedWeekNumber,
        weekStartDate: selectedWeekStart,
        days: { ...DEFAULT_DAYS },
        totalPresent: 0,
        createdBy: req.user._id,
        initializer: { id: req.user._id, role: req.user.role },
      });

      await newRecord.save();
      records = [newRecord.toObject()];
    }

    const formatted = records.map((r) => ({
      _id: r._id,
      week: r.week || `Week ${r.weekNumber}`,
      weekNumber: r.weekNumber,
      weekStartDate: r.weekStartDate,
      days: r.days || { ...DEFAULT_DAYS },
      totalPresent: r.totalPresent || Object.values(r.days || {}).filter((d) => d === "present").length,
    }));

    return res.json({
      success: true,
      studentId: targetStudent._id,
      studentName: targetStudent.name,
      class: targetStudent.class,
      term: {
        id: term._id,
        name: term.term,
        weekNumber: selectedWeekNumber,
      },
      records: formatted,
    });

  } catch (err) {
    console.error("❌ getMyAttendance error:", err);
    return res.status(500).json({
      message: "Failed to fetch attendance",
      error: err.message,
    });
  }
};

// -------------------- Exports --------------------
module.exports = {
  markAttendance,
  getWeeklySummary,
  getDailyBreakdown,
  getStudentTermAttendance,
  getStudentTermTotalAttendance,
  initializeWeek,
  getWeeklyAttendance,
  getMyAttendance
};