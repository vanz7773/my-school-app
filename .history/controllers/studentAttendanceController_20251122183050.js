// StudentAttendanceController.js
const StudentAttendance = require('../models/StudentAttendance');
const Student = require('../models/Student');
const Term = require("../models/term");
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const FeedingFeeConfig = require('../models/FeedingFeeConfig');
const Class = require('../models/Class');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const { getAmountPerDay } = require('../utils/feedingFeeUtils');

// -------------------- Constants & Helper Utilities --------------------
const DEFAULT_DAYS = { M: 'notmarked', T: 'notmarked', W: 'notmarked', TH: 'notmarked', F: 'notmarked' };
const DEFAULT_DAILY = { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null };

const normalizeWeek = (week) => {
  if (week === undefined || week === null) return null;

  // Direct number input
  if (typeof week === 'number' && !isNaN(week)) return Number(week);

  // Extract number from string like "Week 3", "3", "week-4"
  if (typeof week === 'string') {
    const numMatch = week.match(/\d+/);
    if (numMatch) return parseInt(numMatch[0], 10);
    // fallback: if string is numeric
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

// -------------------- Mark Attendance --------------------
const markAttendance = async (req, res) => {
  console.log('📝 markAttendance payload:', req.body);
  const { attendanceUpdates, week, weekNumber: weekParam, termId, classId } = req.body;
  const userId = req.user._id;
  const userRole = req.user.role;
  const schoolId = req.user.school;

  if (!Array.isArray(attendanceUpdates) || attendanceUpdates.length === 0)
    return res.status(400).json({ message: 'attendanceUpdates must be a non-empty array.' });

  try {
    if (!classId || !termId) {
      return res.status(400).json({ message: 'Missing classId or termId' });
    }

    const classObjId = new mongoose.Types.ObjectId(classId);
    const termObjId = new mongoose.Types.ObjectId(termId);

    const classDoc = await Class.findById(classObjId);
    if (!classDoc) return res.status(404).json({ message: 'Class not found' });

    if (userRole === 'teacher' && String(classDoc.classTeacher) !== String(userId))
      return res.status(403).json({ message: 'Only the assigned class teacher can mark attendance' });

    const [term, feeConfig, classStudents] = await Promise.all([
      Term.findOne({ _id: termObjId, school: schoolId }),
      FeedingFeeConfig.findOne({ school: schoolId }),
      Student.find({ class: classObjId, school: schoolId })
        .select('_id class parent parentIds user')
        .populate('class', 'name level')
        .populate('user', 'name')
        .lean()
    ]);

    if (!term) return res.status(404).json({ message: 'Term not found' });

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid or missing week/weekNumber' });

    const weekString = String(weekParam ?? week ?? weekNumber);
    const weekStartDate = getWeekStartDate(term, weekNumber);
    const category = classDoc.category || inferCategoryFromClassName(classDoc.name);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let feedingRecord = await FeedingFeeRecord.findOne({
        school: schoolId,
        classId: classObjId,
        termId: termObjId,
        week: weekNumber
      }).session(session);

      if (!feedingRecord) {
        feedingRecord = new FeedingFeeRecord({
          school: schoolId,
          classId: classObjId,
          termId: termObjId,
          week: weekNumber,
          weekNumber,
          category,
          breakdown: [],
          totalCollected: 0,
          collectedBy: userId,
          date: weekStartDate
        });
      }

      const classSummary = new Map();

      // Store student IDs whose attendance changed
      const changedStudents = new Set();

      // 🧠 Attendance Processing Loop
      for (const update of attendanceUpdates) {
        const studentId = update.studentId || update.student;
        const { days } = update;
        if (!studentId || !days) continue;

        const studentObjId = new mongoose.Types.ObjectId(studentId);
        const student = classStudents.find(s => String(s._id) === String(studentObjId));
        if (!student) continue;

        const existingAttendance = await StudentAttendance.findOne({
          student: studentObjId,
          class: classObjId,
          weekNumber,
          termId: termObjId,
          school: schoolId
        }).session(session);

        const attendanceData = {
          days: existingAttendance ? { ...existingAttendance.days } :
            { M: 'notmarked', T: 'notmarked', W: 'notmarked', TH: 'notmarked', F: 'notmarked' },
          totalPresent: 0,
          week: weekString,
          weekNumber,
          weekStartDate,
          termId: termObjId,
          updatedBy: userId,
          updatedAt: new Date()
        };

        // Detect changed days
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

          await StudentAttendance.findOneAndUpdate(
            { student: studentObjId, class: classObjId, weekNumber, termId: termObjId, school: schoolId },
            { $set: { ...attendanceData, school: schoolId } },
            { upsert: true, session, new: true }
          );
        }

        // Feeding sync
        if (changedDays.size > 0) {
          const amountPerDay = getAmountPerDay(student, feeConfig || {});
          const fedDays = Object.entries(attendanceData.days)
            .filter(([_, status]) => status === 'present')
            .map(([key]) => key);

          const defaultTriState = { M: 'notmarked', T: 'notmarked', W: 'notmarked', TH: 'notmarked', F: 'notmarked' };

          const existingStudentEntry = feedingRecord.breakdown
            .find(b => String(b.student) === String(studentObjId));

          if (!existingStudentEntry) {
            feedingRecord.breakdown.push({
              student: studentObjId,
              studentName: student.user?.name || "Student",
              className: student.class?.name || 'Unknown',
              daysPaid: fedDays.length,
              days: Object.fromEntries(
                Object.entries(defaultTriState).map(([key]) => [
                  key,
                  fedDays.includes(key) ? 'present' : 'absent'
                ])
              ),
              amountPerDay,
              total: fedDays.length * amountPerDay,
              source: 'attendance-sync'
            });
          } else {
            for (const [key] of Object.entries(defaultTriState)) {
              if (fedDays.includes(key)) existingStudentEntry.days[key] = 'present';
              else if (changedDays.has(key)) existingStudentEntry.days[key] = 'absent';
            }
            existingStudentEntry.daysPaid = fedDays.length;
            existingStudentEntry.total = fedDays.length * amountPerDay;
          }
        }
      }

      // Recalculate class total
      feedingRecord.totalCollected = feedingRecord.breakdown
        .reduce((sum, b) => sum + (b.total || 0), 0);

      await feedingRecord.save({ session });

 // ------------------------------------------------------------------
// 🔔 BUILD NOTIFICATIONS FOR PARENTS & STUDENTS of CHANGED STUDENTS
// ------------------------------------------------------------------
if (changedStudents.size > 0) {
  const changed = Array.from(changedStudents);

  const affectedStudents = await Student.find({
    _id: { $in: changed },
    school: schoolId
  })
    .populate("user", "name")
    .populate("parent parentIds")
    .lean();

  for (const stu of affectedStudents) {
    const parentRecipients = new Set();

    // Parent (single)
    if (stu.parent) {
      parentRecipients.add(String(stu.parent._id || stu.parent));
    }

    // Parent IDs (array)
    if (Array.isArray(stu.parentIds)) {
      stu.parentIds.forEach((p) => {
        if (!p) return;
        const id = p._id ? p._id : p;
        parentRecipients.add(String(id));
      });
    }

    /* -----------------------------------------------------------
       PARENT NOTIFICATION  (ONLY parents of this student)
    ----------------------------------------------------------- */
    if (parentRecipients.size > 0) {
      await Notification.create({
        sender: req.user._id,
        school: schoolId,
        title: "Attendance Updated",
        message: `Attendance has been updated for ${stu.user?.name || "your child"}.`,
        type: "attendance",

        // 🔥 CRITICAL FIX
        audience: "parent",
        recipientRoles: ["parent"],
        recipientUsers: Array.from(parentRecipients),

        class: classId,
        studentId: stu._id,
        termId,
        week: weekNumber,
      });
    }

    /* -----------------------------------------------------------
       STUDENT NOTIFICATION  (ONLY this student)
    ----------------------------------------------------------- */
    if (stu.user?._id) {
      await Notification.create({
        sender: req.user._id,
        school: schoolId,
        title: "Attendance Updated",
        message: `Your attendance for week ${weekNumber} has been updated.`,
        type: "attendance",

        // 🔥 CRITICAL FIX
        audience: "student",
        recipientRoles: ["student"],
        recipientUsers: [String(stu.user._id)],

        class: classId,
        studentId: stu._id,
        termId,
        week: weekNumber,
      });
    }
  }

  console.log(`🔔 Notifications sent for ${changed.length} students`);
}


      // commit
      await session.commitTransaction();

      res.json({
        success: true,
        message: `Processed ${attendanceUpdates.length} students successfully`,
        week: weekString,
        weekNumber,
      });

    } catch (err) {
      await session.abortTransaction();
      console.error('💥 markAttendance transaction error:', err);
      throw err;
    } finally {
      session.endSession();
    }
  } 
  catch (error) {
    console.error('⚠️ Attendance Error:', error);
    res.status(500).json({ success: false, message: 'Attendance processing failed', error: error.message });
  }
};


// -------------------- getDailyBreakdown --------------------
const getDailyBreakdown = async (req, res) => {
  const { classId, week, weekNumber: weekParam, termId } = req.query;
  if (!classId || (!week && !weekParam) || !termId)
    return res.status(400).json({ message: 'Missing required query params' });

  try {
    const term = await Term.findOne({ _id: termId, school: req.user.school });
    if (!term) return res.status(404).json({ message: 'Term not found' });

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    const students = await Student.find({ class: classId, school: req.user.school })
      .populate({ path: 'user', select: 'name' });

    const attendanceRecords = await StudentAttendance.find({
      school: req.user.school,
      class: classId,
      termId: term._id,
      weekNumber
    });

    const attendanceMap = {};
    attendanceRecords.forEach(record => {
      if (!record.student) return;
      attendanceMap[String(record.student)] = record.days;
    });

    const result = students.map(student => {
      const sid = String(student._id);
      return {
        studentId: sid,
        name: student.user?.name || 'Unnamed',
        days: attendanceMap[sid] || { ...DEFAULT_DAYS },
        week: String(weekParam ?? week ?? weekNumber),
        weekNumber
      };
    });

    res.json(result);
  } catch (error) {
    console.error('❌ getDailyBreakdown error:', error);
    res.status(500).json({ message: 'Failed to fetch daily breakdown', error: error.message });
  }
};

// -------------------- getWeeklySummary --------------------
const getWeeklySummary = async (req, res) => {
  const { week, weekNumber: weekParam, termId, classId } = req.query;
  try {
    if (!termId) return res.status(400).json({ message: 'Missing termId' });

    const term = await Term.findOne({ _id: termId, school: req.user.school });
    if (!term) return res.status(404).json({ message: 'Term not found' });

    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    const summary = await StudentAttendance.find({
      school: req.user.school,
      class: classId,
      termId: term._id,
      weekNumber
    });

    res.json({ week: String(weekParam ?? week ?? weekNumber), weekNumber, summary });
  } catch (error) {
    console.error('❌ getWeeklySummary error:', error);
    res.status(500).json({ message: 'Failed to fetch weekly summary', error: error.message });
  }
};

// -------------------- getStudentTermAttendance --------------------
const getStudentTermAttendance = async (req, res) => {
  const { studentId, termId } = req.query;
  try {
    if (!termId) return res.status(400).json({ message: 'Missing termId' });
    if (!studentId) return res.status(400).json({ message: 'Missing studentId' });

    const term = await Term.findOne({ _id: termId, school: req.user.school });
    if (!term) return res.status(404).json({ message: 'Term not found' });

    const records = await StudentAttendance.find({
      student: studentId,
      termId: term._id,
      school: req.user.school
    });

    res.json(records);
  } catch (error) {
    console.error('❌ getStudentTermAttendance error:', error);
    res.status(500).json({ message: 'Failed to fetch student term attendance', error: error.message });
  }
};

// -------------------- initializeWeek --------------------
const initializeWeek = async (req, res) => {
  try {
    const { classId, termId, week, weekNumber: weekParam } = req.body;
    const schoolId = req.user?.school?._id || req.user?.school?.id || req.user?.school;
    const userId = req.user._id;
    const userRole = req.user.role;

    if (!classId || !termId) return res.status(400).json({ message: 'Missing classId or termId' });

    if (!['admin', 'teacher'].includes(userRole))
      return res.status(403).json({ message: 'Only admins or class teachers can initialize a week' });

    const classDoc = await Class.findById(classId);
    if (!classDoc) return res.status(404).json({ message: 'Class not found' });

    if (userRole === 'teacher' && String(classDoc.classTeacher) !== String(userId))
      return res.status(403).json({ message: 'Only the assigned class teacher can initialize this class week' });

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

    const students = await Student.find({ class: classId, school: schoolId });
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

    await StudentAttendance.insertMany(attendanceRecords);

    // 🔔 CREATE NOTIFICATION FOR WEEK INITIALIZATION
    await Notification.create({
      sender: req.user._id,
      school: req.user.school,
      title: "Attendance Week Initialized", // ✅ ADDED TITLE
      message: `Attendance week ${weekNumber} initialized for ${classDoc.name}`,
      type: "attendance",
      audience: "teacher",
      class: classId,
      recipientRoles: ["teacher"],
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

// -------------------- getWeeklyAttendance --------------------
const getWeeklyAttendance = async (req, res) => {
  const { classId } = req.params;
  const { termId, week, weekNumber: weekParam } = req.query;
  if (!classId || !termId || (!week && !weekParam))
    return res.status(400).json({ message: 'Missing required parameters' });

  try {
    const weekNumber = normalizeWeek(weekParam ?? week);
    if (!weekNumber) return res.status(400).json({ message: 'Invalid week/weekNumber' });

    const records = await StudentAttendance.find({
      school: req.user.school,
      class: classId,
      weekNumber,
      termId
    }).populate('student');

    res.json({ week: String(weekParam ?? week ?? weekNumber), weekNumber, records });
  } catch (err) {
    console.error('❌ Failed to fetch weekly attendance:', err);
    res.status(500).json({ message: 'Failed to fetch weekly attendance', error: err.message });
  }
};

// -------------------- getMyAttendance (PATCHED + LOGS) --------------------
const getMyAttendance = async (req, res) => {
  try {
    console.log("\n\n==============================");
    console.log("📌 getMyAttendance START");
    console.log("==============================");

    console.log("➡️ Query Params:", req.query);
    console.log("➡️ Body Params:", req.body);

    const termId = req.query.termId || req.body.termId;
    const rawWeek =
      req.query.weekNumber ||
      req.body.weekNumber ||
      req.query.week ||
      req.body.week;

    const weekNumber = normalizeWeek(rawWeek);
    const studentId = req.query.studentId || req.body.studentId;
    const childId = req.query.childId || req.body.childId;
    const schoolId = req.user.school;

    console.log("🔎 termId:", termId);
    console.log("🔎 rawWeek:", rawWeek, "| normalized:", weekNumber);
    console.log("🔎 studentId:", studentId);
    console.log("🔎 childId:", childId);
    console.log("🔎 schoolId:", schoolId);
    console.log("🔎 user role:", req.user.role, "| userId:", req.user._id);

    if (!termId) {
      console.warn("⚠️ Missing termId in request");
      return res.status(400).json({ message: "Missing termId (expected in query or body)" });
    }

    let targetStudent;

    // -----------------------------------
    // STUDENT USER
    // -----------------------------------
    if (req.user.role === "student") {
      console.log("👤 Role: STUDENT — resolving student via Student.user...");

      targetStudent = await Student.findOne({
        user: req.user._id,
        school: schoolId,
      });

      console.log("➡️ Student lookup via `user` returned:", targetStudent?.name || "NONE");

      // 🔥 FIX: Fallback if Student.user isn't linked correctly
      if (!targetStudent) {
        console.log("⚠️ Fallback: checking Student._id === req.user._id OR user match...");
        targetStudent = await Student.findOne({
          school: schoolId,
          $or: [{ _id: req.user._id }, { user: req.user._id }],
        });
        console.log("➡️ Fallback student lookup result:", targetStudent?.name || "NONE");
      }
    }

    // -----------------------------------
    // PARENT USER
    // -----------------------------------
    else if (req.user.role === "parent") {
      console.log("👤 Role: PARENT — resolving child…");

      const targetId = childId || studentId;
      console.log("➡️ Parent resolving childId:", targetId);

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
      });

      console.log("➡️ Parent child lookup result:", targetStudent?.name || "NONE");

      if (!targetStudent) {
        return res.status(403).json({
          message: "Unauthorized: This child is not linked to your parent account.",
        });
      }
    }

    // -----------------------------------
    // TEACHER / ADMIN USER
    // -----------------------------------
    else if (["teacher", "admin"].includes(req.user.role)) {
      console.log("👤 Role:", req.user.role.toUpperCase(), "— resolving target studentId...");

      if (!studentId) {
        console.log("❌ Missing studentId for teacher/admin request");
        return res.status(400).json({
          message: "Missing studentId for teacher/admin request",
        });
      }

      targetStudent = await Student.findOne({
        _id: studentId,
        school: schoolId,
      });

      console.log("➡️ Teacher/Admin student lookup:", targetStudent?.name || "NONE");
    }

    // -----------------------------------
    // STUDENT NOT FOUND
    // -----------------------------------
    if (!targetStudent) {
      console.log("❌ No targetStudent found");
      return res.status(404).json({ message: "Student record not found" });
    }

    console.log("✅ Target Student:", {
      id: targetStudent._id,
      name: targetStudent.name,
      class: targetStudent.class,
    });

    const term = await Term.findById(termId);
    console.log("📘 Loaded term:", term?.term, "| Weeks:", term?.weeks);

    if (!term) {
      console.log("❌ Term not found");
      return res.status(404).json({ message: "Term not found" });
    }

    // -----------------------------------
    // WEEK SELECTION FIX
    // -----------------------------------
    const selectedWeekNumber = weekNumber || term.weekNumber || 1;
    const weekString = `Week ${selectedWeekNumber}`;
    const selectedWeekStart =
      term.weekStartDate ||
      getWeekStartDate(term, selectedWeekNumber);

    console.log("📅 Selected week:", {
      rawWeek,
      selectedWeekNumber,
      weekString,
      selectedWeekStart,
    });

    // -----------------------------------
    // MAIN FIX: LOAD ALL WEEKS FOR TERM
    // -----------------------------------
    const query = {
      $or: [
        { student: targetStudent._id },
        { studentId: targetStudent._id }, // legacy support
      ],
      termId,
      school: schoolId,
    };

    console.log("🔍 Querying attendance with:", query);

    let records = await StudentAttendance.find(query)
      .sort({ weekNumber: 1 })
      .lean();

    console.log("📄 Attendance records found:", records.length);

    // -----------------------------------
    // CREATE WEEK IF NOT FOUND
    // -----------------------------------
    if (!records || records.length === 0) {
      console.log("⚠️ No records found — creating FIRST default week record");

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
      console.log("🆕 Created new default attendance record");

      records = [newRecord.toObject()];
    }

    // -----------------------------------
    // FINAL RESPONSE NORMALIZATION
    // -----------------------------------
    const formatted = records.map((r) => ({
      _id: r._id,
      week: r.week || `Week ${r.weekNumber}`,
      weekNumber: r.weekNumber,
      weekStartDate: r.weekStartDate,
      days: r.days || { ...DEFAULT_DAYS },
      totalPresent:
        r.totalPresent ||
        Object.values(r.days || {}).filter((d) => d === "present").length,
    }));

    console.log("📦 Final formatted records:", formatted);

    console.log("✅ getMyAttendance SUCCESS");
    console.log("==============================\n");

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
  initializeWeek,
  getWeeklyAttendance,
  getMyAttendance
};