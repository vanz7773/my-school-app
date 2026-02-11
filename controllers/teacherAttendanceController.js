const mongoose = require('mongoose');
const Attendance = require('../models/TeacherAttendance');
const Teacher = require('../models/Teacher');
const Term = require("../models/term");
const Notification = require('../models/Notification')

const geofenceValidator = require('../middlewares/geofenceValidator');
const { startOfDay, endOfDay, eachWeekOfInterval, format, addDays } = require('date-fns');
const DeviceBinding = require('../models/DeviceBinding');
const PushToken = require("../models/PushToken")
const { Expo } = require("expo-server-sdk");
const expo = new Expo();


// 🔔 Helper for sending push notifications
async function sendPush(userIds, title, body, extra = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false
  }).lean();

  const validTokens = tokens
    .map(t => t.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (!validTokens.length) return;

  const messages = validTokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data: { type: "teacher-attendance", ...extra }
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (e) {
      console.error("Push chunk error:", e);
    }
  }
}


// ─────────────────────────────────────────────────────────────
// WRAPPER: Apply Geofence Validation Middleware
// ─────────────────────────────────────────────────────────────
const withGeofenceValidation = (handler) => {
  return async (req, res, next) => {
    try {
      await new Promise((resolve, reject) => {
        geofenceValidator(req, res, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      return handler(req, res, next);
    } catch (error) {
      if (res.headersSent) return;
      console.error('Geofence validation wrapper error:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Internal server error during geofence validation',
      });
    }
  };
};

// ─────────────────────────────────────────────────────────────
// Helper: Calculate Term Weeks
// ─────────────────────────────────────────────────────────────
const calculateTermWeeks = (startDate, endDate) => {
  console.log('Calculating term weeks:', { startDate, endDate });
  const weeks = eachWeekOfInterval(
    { start: new Date(startDate), end: new Date(endDate) },
    { weekStartsOn: 1 }
  );

  return weeks.map((weekStart, index) => {
    const weekEnd = addDays(weekStart, 6);
    return {
      weekNumber: index + 1,
      startDate: format(weekStart, 'yyyy-MM-dd'),
      endDate: format(weekEnd, 'yyyy-MM-dd'),
      weekStart,
      weekEnd,
    };
  });
};

// ─────────────────────────────────────────────────────────────
// Helper: Mark absentees for today (Option A – controller-only)
// OPTIMIZED + IDEMPOTENT + SCALABLE
// ─────────────────────────────────────────────────────────────
const markAbsenteesForTodayIfNeeded = async () => {
  const now = new Date();

  // 🕔 School closing time
  const SCHOOL_END_HOUR = 15;
  const SCHOOL_END_MINUTE = 30;

  const cutoff = new Date(now);
  cutoff.setHours(SCHOOL_END_HOUR, SCHOOL_END_MINUTE, 0, 0);

  // ⛔ Only run after school hours
  if (now < cutoff) return;

  const todayStart = startOfDay(now);

  // ⛔ Skip weekends
  const day = todayStart.getDay();
  if (day === 0 || day === 6) return;

  console.log("🕔 Auto-marking absentees for today");

  // 1️⃣ Get all active terms
  const activeTerms = await Term.find(
    {
      startDate: { $lte: todayStart },
      endDate: { $gte: todayStart }
    },
    { _id: 1, school: 1 }
  ).lean();

  if (activeTerms.length === 0) return;

  // 2️⃣ Build bulk operations
  const bulkOps = [];

  for (const term of activeTerms) {
    // Fetch only teacher IDs (lean + projection)
    const teachers = await Teacher.find(
      { school: term.school },
      { _id: 1, school: 1 }
    ).lean();

    for (const teacher of teachers) {
      bulkOps.push({
        updateOne: {
          filter: {
            teacher: teacher._id,
            date: todayStart
          },
          update: {
            $setOnInsert: {
              teacher: teacher._id,
              school: teacher.school,
              term: term._id,
              date: todayStart,
              signInTime: null,
              signOutTime: null,
              status: "Absent"
            },
            // 🔐 CRITICAL FIX:
            // Ensure NO geo field exists on auto-created Absent records
            $unset: {
              location: ""
            }
          },
          upsert: true
        }
      });
    }
  }

  // 3️⃣ Execute once
  if (bulkOps.length > 0) {
    await Attendance.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(`✅ Absentees processed: ${bulkOps.length}`);
};


// ─────────────────────────────────────────────────────────────
// CLOCK IN / OUT (LOCKED, ONE-WAY, PRODUCTION VERSION)
// ─────────────────────────────────────────────────────────────
const clockAttendance = async (req, res) => {
  const { teacherId, type, timestamp, date, termId, deviceUUID, latitude, longitude } = req.body;
  const isAdmin = req.user.role === "admin";

  // ─── BASIC VALIDATION ──────────────────────────────────────
  if (!["in", "out"].includes(type)) {
    return res.status(400).json({ status: "fail", message: 'Invalid type. Must be "in" or "out".' });
  }

  const clockTime = new Date(timestamp);
  if (isNaN(clockTime.getTime())) {
    return res.status(400).json({ status: "fail", message: "Invalid timestamp format." });
  }

  if (!deviceUUID) {
    return res.status(400).json({ status: "fail", message: "Device ID missing. Please restart the app." });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({
      status: "fail",
      message: "Invalid location detected. Please enable GPS and try again.",
    });
  }

  try {
    // ─── TERM ────────────────────────────────────────────────
    const term = await Term.findById(termId);
    if (!term) {
      return res.status(404).json({ status: "fail", message: "Term not found." });
    }

    // ─── TEACHER ─────────────────────────────────────────────
    const teacher = isAdmin && teacherId
      ? await Teacher.findById(teacherId).populate("school user")
      : await Teacher.findOne({ user: req.user.id }).populate("school user");

    if (!teacher || !teacher.school) {
      return res.status(404).json({ status: "fail", message: "Teacher not properly assigned." });
    }

    // ─── DEVICE BINDING (UNCHANGED) ──────────────────────────
    const existingByDevice = await DeviceBinding.findOne({ deviceUUID });
    if (existingByDevice && !existingByDevice.teacher.equals(teacher._id)) {
      return res.status(403).json({
        status: "fail",
        message: "This device belongs to another teacher.",
      });
    }

    const existingByTeacher = await DeviceBinding.findOne({ teacher: teacher._id });
    if (!existingByTeacher) {
      await DeviceBinding.create({ teacher: teacher._id, deviceUUID });
    } else if (existingByTeacher.deviceUUID !== deviceUUID) {
      return res.status(403).json({
        status: "fail",
        message: "Your account is linked to another device.",
      });
    }

    // ─── ATTENDANCE LOOKUP (DAY-LOCKED) ──────────────────────
    const attendanceDate = date ? new Date(date) : clockTime;
    const dayStart = startOfDay(attendanceDate);
    const dayEnd = endOfDay(attendanceDate);

    let attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: dayStart, $lte: dayEnd },
    });

    const lateThreshold = new Date(dayStart);
    lateThreshold.setHours(8, 0, 0, 0);

    // ─────────────────────────────────────────────────────────
    // CLOCK IN (Absent → On Time / Late)
    // ─────────────────────────────────────────────────────────
    if (type === "in") {
      if (!attendance) {
        attendance = new Attendance({
          teacher: teacher._id,
          school: teacher.school._id,
          term: term._id,
          date: attendanceDate
        });
      }

      if (attendance.signInTime) {
        return res.status(400).json({
          status: "fail",
          message: "You have already clocked in today.",
        });
      }

      attendance.signInTime = clockTime;
      attendance.status = clockTime > lateThreshold ? "Late" : "On Time";
    }

    // ─────────────────────────────────────────────────────────
    // CLOCK OUT (FINAL STATE)
    // ─────────────────────────────────────────────────────────
    if (type === "out") {
      if (!attendance || !attendance.signInTime) {
        return res.status(400).json({
          status: "fail",
          message: "You must clock in before clocking out.",
        });
      }

      if (attendance.signOutTime) {
        return res.status(400).json({
          status: "fail",
          message: "You have already clocked out today.",
        });
      }

      attendance.signOutTime = clockTime;
    }

    // ─── COMMON UPDATE ───────────────────────────────────────
    attendance.location = {
      type: "Point",
      coordinates: [lng, lat],
    };
    attendance.term = term._id;

    await attendance.save();

    // ─── RESPONSE ────────────────────────────────────────────
    return res.status(200).json({
      status: "success",
      data: {
        attendance,
        message: type === "in"
          ? "Clock-in successful. Have a great day!"
          : "Clock-out successful. Goodbye!",
        teacherId: teacher._id,
        geofenceStatus: req.geofenceStatus || "validated",
        distanceFromCenter: req.geofenceData?.distanceFromCenter || null,
      },
    });

  } catch (err) {
    console.error("Clock attendance error:", err);
    return res.status(500).json({
      status: "error",
      message: "Something went wrong. Please try again.",
    });
  }
};



// ─────────────────────────────────────────────────────────────
// TEACHER DAILY RECORDS (WITH FIXED TEACHER LOOKUP)
// ─────────────────────────────────────────────────────────────
const getTeacherDailyRecords = async (req, res) => {
  console.log('=== GET TEACHER DAILY RECORDS STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const teacher = await Teacher.findOne({ user: req.user.id })
      .populate({
        path: 'school',
        match: { _id: { $exists: true } } // Ensure school exists
      });

    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      console.log('Teacher not found');
      return res.status(404).json({ status: 'fail', message: 'Teacher not found' });
    }

    if (!teacher.school) {
      console.log('Teacher found but school not assigned');
      return res.status(404).json({ status: 'fail', message: 'Teacher is not assigned to a school.' });
    }

    const records = await Attendance.find({ teacher: teacher._id })
      .sort({ date: -1 })
      .limit(30);

    console.log('Records found:', records.length);

    res.status(200).json({ status: 'success', data: records });
  } catch (err) {
    console.error('Teacher daily records error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch daily records' });
  } finally {
    console.log('=== GET TEACHER DAILY RECORDS COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// ADMIN DAILY RECORDS
// ─────────────────────────────────────────────────────────────
const getAdminDailyRecords = async (req, res) => {
  console.log('=== GET ADMIN DAILY RECORDS STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const { teacherId, from, to, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId) match.teacher = new mongoose.Types.ObjectId(teacherId);
    if (from && to) {
      match.date = {
        $gte: startOfDay(new Date(from)),
        $lte: endOfDay(new Date(to))
      };
    }

    if (termId) {
      const term = await Term.findOne({ _id: termId, school: req.user.school });
      if (!term) {
        return res.status(404).json({
          status: 'fail',
          message: 'Term not found'
        });
      }
      match.term = term._id;
    }

    const records = await Attendance.find(match)
      .populate({ path: 'teacher', populate: { path: 'user', select: 'name' } })
      .sort({ date: -1 });

    console.log('Records found:', records.length);

    // Weekly chart calculation
    const dayCounts = {};
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    weekdays.forEach(day => {
      dayCounts[day] = { total: 0, present: 0 };
    });

    records.forEach(record => {
      try {
        const recordDate = new Date(record.date);
        const day = recordDate.toLocaleDateString('en-US', { weekday: 'long' });

        if (weekdays.includes(day)) {
          dayCounts[day].total += 1;

          // Present = On Time or Late (Absent now exists explicitly)
          if (['On Time', 'Late'].includes(record.status)) {
            dayCounts[day].present += 1;
          }
        }
      } catch (error) {
        console.error('Error processing record:', record._id, error);
      }
    });

    const weeklyChart = weekdays.map(day => {
      const dayData = dayCounts[day];
      return {
        day,
        presentPercentage:
          dayData.total > 0
            ? Math.round((dayData.present / dayData.total) * 100)
            : 0,
        presentCount: dayData.present,
        totalCount: dayData.total
      };
    });

    res.status(200).json({
      status: 'success',
      data: {
        records,
        weeklyChart
      }
    });
  } catch (err) {
    console.error('Admin daily records error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch daily records'
    });
  } finally {
    console.log('=== GET ADMIN DAILY RECORDS COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// GET TERM WEEKS
// ─────────────────────────────────────────────────────────────
const getTermWeeks = async (req, res) => {
  console.log('=== GET TERM WEEKS STARTED ===');
  console.log('Term ID:', req.params.termId);

  try {
    const term = await Term.findById(req.params.termId);
    if (!term) return res.status(404).json({ status: 'fail', message: 'Term not found' });

    const weeks = calculateTermWeeks(term.startDate, term.endDate);

    res.status(200).json({
      status: 'success',
      data: {
        termInfo: { academicYear: term.academicYear, term: term.name, startDate: term.startDate, endDate: term.endDate },
        weeks
      }
    });
  } catch (err) {
    console.error('Get term weeks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch term weeks' });
  } finally {
    console.log('=== GET TERM WEEKS COMPLETED ===');
  }
};

// ─────────────────────────────────────────────────────────────
// ADMIN WEEKLY SUMMARY
// ─────────────────────────────────────────────────────────────
const getAdminWeeklySummary = async (req, res) => {
  console.log('=== GET ADMIN WEEKLY SUMMARY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const { teacherId, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId) {
      match.teacher = new mongoose.Types.ObjectId(teacherId);
      console.log('Filtering by teacher ID:', teacherId);
    }

    let termWeeks = [];
    if (termId) {
      console.log('Looking up term with ID:', termId);
      const term = await Term.findOne({
        _id: termId,
        school: req.user.school
      });

      if (!term) {
        console.log('Term not found');
        return res.status(404).json({
          status: 'fail',
          message: 'Term not found'
        });
      }

      match.date = {
        $gte: startOfDay(new Date(term.startDate)),
        $lte: endOfDay(new Date(term.endDate))
      };

      termWeeks = calculateTermWeeks(term.startDate, term.endDate);
      console.log('Calculating term weeks:', termWeeks.length);
    }

    // Allow overriding with specific date range (e.g. for specific week)
    const { from, to } = req.query;
    if (from && to) {
      match.date = {
        $gte: startOfDay(new Date(from)),
        $lte: endOfDay(new Date(to))
      };
      console.log('Overriding filter with date range:', { from, to });
    }

    const summary = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            weekStart: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: { $dateTrunc: { date: "$date", unit: "week" } }
              }
            },
            weekEnd: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: {
                  $dateAdd: {
                    startDate: { $dateTrunc: { date: "$date", unit: "week" } },
                    unit: "day",
                    amount: 6
                  }
                }
              }
            },
            teacher: "$teacher"
          },
          total: { $sum: 1 },
          present: { $sum: { $cond: [{ $in: ["$status", ["On Time", "Late"]] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ["$status", "Late"] }, 1, 0] } }
        }
      },
      {
        $lookup: {
          from: 'teachers',
          localField: '_id.teacher',
          foreignField: '_id',
          as: 'teacher'
        }
      },
      { $unwind: '$teacher' },
      {
        $lookup: {
          from: 'users',
          localField: 'teacher.user',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          weekStart: '$_id.weekStart',
          weekEnd: '$_id.weekEnd',
          teacherName: '$user.name',
          total: 1,
          present: 1,
          late: 1
        }
      },
      { $sort: { weekStart: -1 } }
    ]);

    console.log('Aggregation result count:', summary.length);

    // If we have term weeks, map the week numbers to the summary
    if (termId && termWeeks.length > 0) {
      const summaryWithWeekNumbers = summary.map(week => {
        const matchingTermWeek = termWeeks.find(termWeek =>
          new Date(termWeek.startDate).toISOString() === new Date(week.weekStart).toISOString()
        );

        return {
          ...week,
          weekNumber: matchingTermWeek?.weekNumber || null,
          weekLabel: matchingTermWeek ? `Week ${matchingTermWeek.weekNumber}` : 'Unknown Week'
        };
      });

      res.status(200).json({
        status: 'success',
        data: {
          termWeeks,
          attendance: summaryWithWeekNumbers,
          currentWeek: termWeeks.find(week => week.isCurrent)
        }
      });
    } else {
      res.status(200).json({
        status: 'success',
        data: summary
      });
    }
  } catch (err) {
    console.error('Admin weekly summary error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch weekly summary'
    });
  } finally {
    console.log('=== GET ADMIN WEEKLY SUMMARY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// TEACHER WEEKLY SUMMARY (only weeks with attendance records)
// ─────────────────────────────────────────────────────────────
const getTeacherWeeklySummary = async (req, res) => {
  console.log('=== GET TEACHER WEEKLY SUMMARY STARTED ===');
  console.log('Query params:', req.query);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const teacher = await Teacher.findOne({ user: req.user.id }).populate('school');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const { termId } = req.query;
    let currentTerm;

    // Get the term (either specified or current term)
    if (termId) {
      currentTerm = await Term.findById(termId);
    } else {
      currentTerm = await Term.findOne({
        school: teacher.school._id,
        isCurrent: true
      });
    }

    if (!currentTerm) {
      return res.status(404).json({
        status: 'fail',
        message: 'No term found'
      });
    }

    const termStart = new Date(currentTerm.startDate);
    const termEnd = new Date(currentTerm.endDate);

    // Build match conditions
    const matchConditions = {
      teacher: teacher._id,
      date: {
        $gte: termStart,
        $lte: termEnd,
        $type: 'date'
      }
    };

    console.log('Term date range:', termStart, 'to', termEnd);

    const attendanceData = await Attendance.find(matchConditions)
      .sort({ date: 1 })
      .lean();

    // Group by consistent week numbers (aligned with homepage)
    const weeklySummary = {};
    const millisecondsPerWeek = 7 * 24 * 60 * 60 * 1000;

    attendanceData.forEach(record => {
      const recordDate = new Date(record.date);

      // Calculate week number exactly like the homepage
      const weekNumber = Math.floor((recordDate - termStart) / millisecondsPerWeek) + 1;

      // Ensure week number is within bounds
      const boundedWeek = Math.max(1, Math.min(weekNumber,
        Math.ceil((termEnd - termStart) / millisecondsPerWeek)));

      if (!weeklySummary[boundedWeek]) {
        weeklySummary[boundedWeek] = {
          week: boundedWeek,
          year: recordDate.getFullYear(),
          total: 0,
          present: 0,
          late: 0
        };
      }

      weeklySummary[boundedWeek].total++;

      if (record.status === 'On Time' || record.status === 'Late') {
        weeklySummary[boundedWeek].present++;
      }

      if (record.status === 'Late') {
        weeklySummary[boundedWeek].late++;
      }
    });

    // Convert to array (only weeks with attendance records)
    const result = Object.values(weeklySummary);

    // Sort by week descending (most recent first)
    result.sort((a, b) => b.week - a.week);

    console.log('Weekly summary generated:', result.length, 'weeks with attendance records');

    res.status(200).json({
      status: 'success',
      data: result
    });
  } catch (err) {
    console.error('Teacher weekly summary error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch weekly summary'
    });
  } finally {
    console.log('=== GET TEACHER WEEKLY SUMMARY COMPLETED ===');
  }
};

// ─────────────────────────────────────────────────────────────
// TEACHER MONTHLY SUMMARY
// ─────────────────────────────────────────────────────────────
const getTeacherMonthlySummary = async (req, res) => {
  console.log('=== GET TEACHER MONTHLY SUMMARY STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const teacher = await Teacher.findOne({ user: req.user.id });
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      console.log('Teacher not found');
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const summary = await Attendance.aggregate([
      { $match: { teacher: teacher._id } },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' }
          },
          total: { $sum: 1 },
          present: {
            $sum: {
              $cond: [{ $in: ['$status', ['On Time', 'Late']] }, 1, 0]
            }
          },
          late: {
            $sum: {
              $cond: [{ $eq: ['$status', 'Late'] }, 1, 0]
            }
          }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);

    console.log('Monthly summary count:', summary.length);

    res.status(200).json({
      status: 'success',
      data: summary
    });
  } catch (err) {
    console.error('Teacher monthly summary error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch monthly summary'
    });
  } finally {
    console.log('=== GET TEACHER MONTHLY SUMMARY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// ADMIN MONTHLY SUMMARY
// ─────────────────────────────────────────────────────────────
const getAdminMonthlySummary = async (req, res) => {
  console.log('=== GET ADMIN MONTHLY SUMMARY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const { teacherId, from, to } = req.query;
    const match = { school: req.user.school };

    if (teacherId) {
      match.teacher = new mongoose.Types.ObjectId(teacherId);
      console.log('Filtering by teacher ID:', teacherId);
    }

    if (from && to) {
      match.date = {
        $gte: startOfDay(new Date(from)),
        $lte: endOfDay(new Date(to))
      };
      console.log('Filtering by date range:', { from, to });
    }

    const summary = await Attendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' },
            teacher: '$teacher'
          },
          total: { $sum: 1 },
          present: {
            $sum: {
              $cond: [{ $in: ['$status', ['On Time', 'Late']] }, 1, 0]
            }
          },
          late: {
            $sum: {
              $cond: [{ $eq: ['$status', 'Late'] }, 1, 0]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'teachers',
          localField: '_id.teacher',
          foreignField: '_id',
          as: 'teacher'
        }
      },
      { $unwind: '$teacher' },
      {
        $lookup: {
          from: 'users',
          localField: 'teacher.user',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          teacherName: '$user.name',
          total: 1,
          present: 1,
          late: 1
        }
      },
      { $sort: { year: -1, month: -1 } }
    ]);

    console.log('Monthly summary count:', summary.length);

    res.status(200).json({
      status: 'success',
      data: summary
    });
  } catch (err) {
    console.error('Admin monthly summary error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch monthly summary'
    });
  } finally {
    console.log('=== GET ADMIN MONTHLY SUMMARY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// TEACHER TODAY'S ATTENDANCE (AUTHORITATIVE VERSION)
// ─────────────────────────────────────────────────────────────
const getTodayAttendance = async (req, res) => {
  console.log('=== GET TODAY ATTENDANCE STARTED ===');
  console.log('User ID:', req.user.id);

  // Ensure system-generated absentees are marked (idempotent)
  await markAbsenteesForTodayIfNeeded();

  try {
    const teacher = await Teacher.findOne({ user: req.user.id });
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    console.log('Today date range:', { todayStart, todayEnd });

    const attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: todayStart, $lte: todayEnd }
    });

    console.log('Today attendance:', attendance);

    // 🔐 AUTHORITATIVE PERMISSIONS (NO GUESSING)
    const canClockIn =
      !attendance || !attendance.signInTime;

    const canClockOut =
      !!attendance?.signInTime && !attendance?.signOutTime;

    res.status(200).json({
      status: 'success',
      data: {
        status: attendance?.status || 'Absent',
        clockedIn: !!attendance?.signInTime,
        clockedOut: !!attendance?.signOutTime,
        canClockIn,
        canClockOut,
        lastAction: attendance?.signOutTime || attendance?.signInTime || null
      }
    });

  } catch (err) {
    console.error('Today attendance error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch today\'s attendance'
    });
  } finally {
    console.log('=== GET TODAY ATTENDANCE COMPLETED ===');
  }
};

// ─────────────────────────────────────────────────────────────
// TEACHER MISSED CLOCKOUTS
// ─────────────────────────────────────────────────────────────
const getMissedClockouts = async (req, res) => {
  console.log('=== GET MISSED CLOCKOUTS STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    const teacher = await Teacher.findOne({ user: req.user.id });
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      console.log('Teacher not found');
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const missed = await Attendance.find({
      teacher: teacher._id,
      signInTime: { $ne: null },
      signOutTime: null
    })
      .sort({ date: -1 })
      .limit(5);

    console.log('Missed clockouts found:', missed.length);

    res.status(200).json({
      status: 'success',
      data: missed
    });
  } catch (err) {
    console.error('Missed clockouts error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch missed clockouts'
    });
  } finally {
    console.log('=== GET MISSED CLOCKOUTS COMPLETED ===');
  }
};

// ─────────────────────────────────────────────────────────────
// TEACHER ATTENDANCE HISTORY
// ─────────────────────────────────────────────────────────────
const getTeacherAttendanceHistory = async (req, res) => {
  console.log('=== GET TEACHER ATTENDANCE HISTORY STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const teacher = await Teacher.findOne({ user: req.user.id });
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      console.log('Teacher not found');
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const history = await Attendance.find({ teacher: teacher._id })
      .sort({ date: -1 })
      .select('date signInTime signOutTime status location')
      .limit(30);

    console.log('History records found:', history.length);

    res.status(200).json({
      status: 'success',
      data: history
    });
  } catch (err) {
    console.error('Attendance history error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch attendance history'
    });
  } finally {
    console.log('=== GET TEACHER ATTENDANCE HISTORY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// ADMIN ATTENDANCE HISTORY
// ─────────────────────────────────────────────────────────────
const getAdminAttendanceHistory = async (req, res) => {
  console.log('=== GET ADMIN ATTENDANCE HISTORY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // 👇 NEW: Ensure absentees are marked for today (after school hours)
    await markAbsenteesForTodayIfNeeded();

    const { teacherId } = req.query;
    const filter = { school: req.user.school };

    if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
      filter.teacher = teacherId;
      console.log('Filtering by teacher ID:', teacherId);
    }

    const history = await Attendance.find(filter)
      .populate({
        path: 'teacher',
        populate: { path: 'user', select: 'name ' }
      })
      .sort({ date: -1 });

    console.log('History records found:', history.length);

    res.status(200).json({
      status: 'success',
      data: history
    });
  } catch (err) {
    console.error('Admin attendance history error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch admin attendance history'
    });
  } finally {
    console.log('=== GET ADMIN ATTENDANCE HISTORY COMPLETED ===');
  }
};

// ─────────────────────────────────────────────────────────────
// EXPORTS (UPDATE TO USE THE VALIDATED VERSION)
// ─────────────────────────────────────────────────────────────
module.exports = {
  clockAttendance: withGeofenceValidation(clockAttendance),
  getTeacherDailyRecords,
  getAdminDailyRecords,
  getTermWeeks,
  getTeacherWeeklySummary,
  getAdminWeeklySummary,
  getTeacherMonthlySummary,
  getAdminMonthlySummary,
  getTodayAttendance,
  getMissedClockouts,
  getTeacherAttendanceHistory,
  getAdminAttendanceHistory,
};