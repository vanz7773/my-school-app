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
        message: 'Geofence validation failed due to a server error. Please try again.',
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
  if (now < cutoff) {
    console.log(`[ABSENTEE] Skipping: too early (${now.toLocaleTimeString()} < ${cutoff.toLocaleTimeString()})`);
    return;
  }

  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  console.log(`[ABSENTEE] Running for range: ${todayStart.toISOString()} - ${todayEnd.toISOString()}`);

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
            date: { $gte: todayStart, $lte: todayEnd }
          },
          update: {
            $setOnInsert: {
              teacher: teacher._id,
              school: teacher.school,
              term: term._id,
              date: todayStart,
              signInTime: null,
              signOutTime: null,
              status: "Absent",
              location: undefined // 🚀 Explicitly undefined to avoid Mongoose defaults
            }
          },
          upsert: true
        }
      });
    }
  }

  // 3️⃣ Execute once
  if (bulkOps.length > 0) {
    console.log(`[ABSENTEE] Executing bulkWrite with ${bulkOps.length} ops`);
    const result = await Attendance.bulkWrite(bulkOps, { ordered: false });
    console.log(`[ABSENTEE] Success: upserted=${result.upsertedCount}, modified=${result.modifiedCount}`);
  }

  console.log(`✅ Absentees processed: ${bulkOps.length}`);
};


// ─────────────────────────────────────────────────────────────
// CLOCK IN / OUT (LOCKED, ONE-WAY, PRODUCTION VERSION)
// ─────────────────────────────────────────────────────────────
const clockAttendance = async (req, res) => {
  console.log('\n========================================');
  console.log('[CLOCK] === CLOCK ATTENDANCE STARTED ===');
  console.log('[CLOCK] Request body:', JSON.stringify({
    type: req.body.type,
    timestamp: req.body.timestamp,
    date: req.body.date,
    termId: req.body.termId,
    deviceUUID: req.body.deviceUUID,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    teacherId: req.body.teacherId,
  }, null, 2));
  console.log('[CLOCK] User:', JSON.stringify({ id: req.user?.id, role: req.user?.role, school: req.user?.school }));
  console.log('[CLOCK] Geofence status from middleware:', req.geofenceStatus);
  console.log('[CLOCK] Geofence data from middleware:', JSON.stringify(req.geofenceData || {}));
  console.log('========================================\n');

  const { teacherId, type, timestamp, date, termId, deviceUUID, latitude, longitude } = req.body;
  const isAdmin = req.user.role === "admin";

  if (!["in", "out"].includes(type)) {
    console.log('[CLOCK] ❌ Invalid type:', type);
    return res.status(400).json({ status: "fail", message: 'Invalid type. Must be "in" or "out".' });
  }

  const clockTime = new Date(timestamp);
  if (isNaN(clockTime.getTime())) {
    console.log('[CLOCK] ❌ Invalid timestamp:', timestamp);
    return res.status(400).json({ status: "fail", message: "Invalid timestamp format." });
  }
  console.log('[CLOCK] ✅ Clock time parsed:', clockTime.toISOString());

  if (!deviceUUID) {
    console.log('[CLOCK] ❌ Missing deviceUUID');
    return res.status(400).json({ status: "fail", message: "Device ID missing. Please restart the app." });
  }
  console.log('[CLOCK] ✅ Device UUID:', deviceUUID);

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng)) {
    console.log('[CLOCK] ❌ Invalid coordinates:', { latitude, longitude, lat, lng });
    return res.status(400).json({ status: "fail", message: "Invalid location detected. Please ensure your GPS is enabled and try again." });
  }
  console.log(`[CLOCK] ✅ Coordinates: lat=${lat}, lng=${lng}`);

  try {
    const term = await Term.findById(termId);
    if (!term) {
      console.log('[CLOCK] ❌ Term not found:', termId);
      return res.status(404).json({ status: "fail", message: "Term not found." });
    }
    console.log('[CLOCK] ✅ Term found:', term.name || term._id);

    const teacher = isAdmin && teacherId
      ? await Teacher.findById(teacherId).populate("school user")
      : await Teacher.findOne({ user: req.user.id }).populate("school user");

    if (!teacher || !teacher.school) {
      console.log('[CLOCK] ❌ Teacher not found or not assigned. isAdmin:', isAdmin, 'teacherId:', teacherId, 'userId:', req.user.id);
      return res.status(404).json({ status: "fail", message: "Teacher not properly assigned." });
    }
    console.log('[CLOCK] ✅ Teacher found:', teacher.user?.name || teacher._id, '| School:', teacher.school?.name || teacher.school?._id);

    // Device binding checks
    const existingByDevice = await DeviceBinding.findOne({ deviceUUID });
    console.log('[CLOCK] Device binding by UUID:', existingByDevice ? `Bound to teacher ${existingByDevice.teacher}` : 'Not found');
    if (existingByDevice && !existingByDevice.teacher.equals(teacher._id)) {
      console.log('[CLOCK] ❌ Device bound to different teacher:', existingByDevice.teacher.toString(), '!= ', teacher._id.toString());
      return res.status(403).json({ status: "fail", message: "This device is registered to another teacher. Contact HeadTeacher." });
    }

    const existingByTeacher = await DeviceBinding.findOne({ teacher: teacher._id });
    console.log('[CLOCK] Device binding by teacher:', existingByTeacher ? `UUID: ${existingByTeacher.deviceUUID}` : 'Not found');
    if (!existingByTeacher) {
      await DeviceBinding.create({ teacher: teacher._id, deviceUUID });
      console.log('[CLOCK] ✅ New device binding created');
    } else if (existingByTeacher.deviceUUID !== deviceUUID) {
      console.log('[CLOCK] ❌ Teacher linked to different device:', existingByTeacher.deviceUUID, '!= ', deviceUUID);
      return res.status(403).json({ status: "fail", message: "Your account is linked to another device." });
    }

    const attendanceDate = date ? new Date(date) : clockTime;
    const dayStart = startOfDay(attendanceDate);
    const dayEnd = endOfDay(attendanceDate);
    console.log('[CLOCK] Date range:', dayStart.toISOString(), '-', dayEnd.toISOString());

    let attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: dayStart, $lte: dayEnd },
    });
    console.log('[CLOCK] Existing attendance record:', attendance ? JSON.stringify({
      id: attendance._id,
      status: attendance.status,
      signInTime: attendance.signInTime,
      signOutTime: attendance.signOutTime,
    }) : 'None');

    if (type === "in" && !attendance) {
      console.log(`[CLOCK] Cleaning up potential duplicates for ${teacher._id} on today`);
      const deleteResult = await Attendance.deleteMany({
        teacher: teacher._id,
        date: { $gte: dayStart, $lte: dayEnd }
      });
      console.log('[CLOCK] Deleted duplicates:', deleteResult.deletedCount);
    }

    const lateThreshold = new Date(dayStart);
    lateThreshold.setHours(7, 30, 0, 0);
    console.log('[CLOCK] Late threshold:', lateThreshold.toISOString());

    if (type === "in") {
      if (!attendance) {
        attendance = new Attendance({
          teacher: teacher._id,
          school: teacher.school._id,
          term: term._id,
          date: dayStart
        });
        console.log('[CLOCK] ✅ Created new attendance record');
      }
      if (attendance.signInTime) {
        console.log('[CLOCK] ❌ Already clocked in:', attendance.signInTime);
        return res.status(400).json({ status: "fail", message: "You have already clocked in today." });
      }
      attendance.signInTime = clockTime;
      attendance.status = clockTime > lateThreshold ? "Late" : "On Time";
      console.log('[CLOCK] ✅ Clock-in recorded. Status:', attendance.status);
    }

    if (type === "out") {
      if (!attendance || !attendance.signInTime) {
        console.log('[CLOCK] ❌ Cannot clock out - no clock-in found');
        return res.status(400).json({ status: "fail", message: "You must clock in before clocking out." });
      }
      if (attendance.signOutTime) {
        console.log('[CLOCK] ❌ Already clocked out:', attendance.signOutTime);
        return res.status(400).json({ status: "fail", message: "You have already clocked out today." });
      }
      attendance.signOutTime = clockTime;
      console.log('[CLOCK] ✅ Clock-out recorded');
    }

    attendance.location = { type: "Point", coordinates: [lng, lat] };
    attendance.term = term._id;
    await attendance.save();
    console.log('[CLOCK] ✅ Attendance saved successfully. ID:', attendance._id);

    console.log('[CLOCK] === CLOCK ATTENDANCE COMPLETED SUCCESSFULLY ===\n');
    return res.status(200).json({
      status: "success",
      data: {
        attendance,
        message: type === "in" ? "Clock-in successful." : "Clock-out successful.",
        teacherId: teacher._id,
        geofenceStatus: req.geofenceStatus || "validated",
        distanceFromCenter: req.geofenceData?.distanceFromCenter || null,
      },
    });
  } catch (err) {
    console.error("[CLOCK] ❌ Clock attendance error:", err);
    return res.status(500).json({ status: "error", message: "Service unavailable. Please try again or contact your administrator." });
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

    // 1️⃣ Fetch all teachers for this school to ensure "Always list all teachers"
    const teacherQuery = { school: req.user.school };
    if (teacherId) teacherQuery._id = new mongoose.Types.ObjectId(teacherId);
    
    const allTeachers = await Teacher.find(teacherQuery)
      .populate({ path: 'user', select: 'name' })
      .lean();
      
    // Sort teachers alphabetically by name
    allTeachers.sort((a, b) => (a.user?.name || '').localeCompare(b.user?.name || ''));

    // 2️⃣ Fetch actual attendance records
    const records = await Attendance.find(match)
      .populate({ path: 'teacher', populate: { path: 'user', select: 'name' } })
      .sort({ date: -1 });

    // 3️⃣ Generate the full list with placeholders
    let finalRecords = [];
    
    if (from && to) {
      const startDate = startOfDay(new Date(from));
      const endDate = startOfDay(new Date(to));
      
      // Generate array of all dates in range (ascending order - as requested)
      const dates = [];
      let current = new Date(startDate);
      while (current <= endDate) {
        dates.push(new Date(current));
        current.setDate(current.getDate() + 1);
      }

      for (const date of dates) {
        // Skip weekends
        if (date.getDay() === 0 || date.getDay() === 6) continue;

        // Collect all records for this specific date
        const dayRecords = [];

        for (const teacher of allTeachers) {
          const existing = records.find(r => 
            r.teacher?._id?.toString() === teacher._id.toString() &&
            startOfDay(new Date(r.date)).getTime() === date.getTime()
          );

          if (existing) {
            dayRecords.push(existing);
          } else {
            dayRecords.push({
              _id: `temp-${teacher._id}-${date.getTime()}`,
              teacher: teacher,
              date: date,
              status: 'Absent',
              signInTime: null,
              signOutTime: null,
              isPlaceholder: true
            });
          }
        }

        // Sort teachers for this day by sign-in time (Arrived first, then placeholders)
        dayRecords.sort((a, b) => {
          if (a.signInTime && b.signInTime) {
            return new Date(a.signInTime).getTime() - new Date(b.signInTime).getTime();
          }
          if (a.signInTime) return -1;
          if (b.signInTime) return 1;
          // Both are placeholders, keep alphabetical (already sorted in allTeachers)
          return 0;
        });

        finalRecords.push(...dayRecords);
      }
    } else {
      // Fallback if no dates provided (shouldn't happen with current frontend)
      finalRecords = records;
    }

    console.log('Final records count:', finalRecords.length);

    // Weekly chart calculation (use finalRecords for stats)
    const dayCounts = {};
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    weekdays.forEach(day => {
      dayCounts[day] = { total: 0, present: 0 };
    });

    finalRecords.forEach(record => {
      try {
        const recordDate = new Date(record.date);
        const day = recordDate.toLocaleDateString('en-US', { weekday: 'long' });

        if (weekdays.includes(day)) {
          dayCounts[day].total += 1;

          // Present = On Time or Late
          if (['On Time', 'Late', 'Present'].includes(record.status)) {
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
        records: finalRecords,
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
          late: { $sum: { $cond: [{ $eq: ["$status", "Late"] }, 1, 0] } },
          holiday: { $sum: { $cond: [{ $eq: ["$status", "Holiday"] }, 1, 0] } }
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
          late: 1,
          holiday: 1
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
        $lte: termEnd
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
          late: 0,
          holiday: 0
        };
      }

      weeklySummary[boundedWeek].total++;

      if (record.status === 'On Time' || record.status === 'Late') {
        weeklySummary[boundedWeek].present++;
      }

      if (record.status === 'Late') {
        weeklySummary[boundedWeek].late++;
      }

      if (record.status === 'Holiday') {
        weeklySummary[boundedWeek].holiday++;
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
          },
          holiday: {
            $sum: {
              $cond: [{ $eq: ['$status', 'Holiday'] }, 1, 0]
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
          },
          holiday: {
            $sum: {
              $cond: [{ $eq: ['$status', 'Holiday'] }, 1, 0]
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
          late: 1,
          holiday: 1
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

    const attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: todayStart, $lte: todayEnd }
    });

    // 🔐 AUTHORITATIVE PERMISSIONS (NO GUESSING)
    // Block clock-in/out when the status is Holiday or Absent (manual admin entry)
    const isManualStatus = attendance?.status === 'Holiday' || attendance?.status === 'Absent';

    const canClockIn =
      !isManualStatus && (!attendance || !attendance.signInTime);

    const canClockOut =
      !isManualStatus && !!attendance?.signInTime && !attendance?.signOutTime;

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
// ADMIN MARK MANUAL ATTENDANCE (E.g. Holiday, Absent)
// ─────────────────────────────────────────────────────────────
const markManualAttendance = async (req, res) => {
  console.log('=== MARK MANUAL ATTENDANCE STARTED ===');
  console.log('Request body:', req.body);
  try {
    const { date, teacherId, status } = req.body;
    const schoolId = req.user.school;

    if (!date || !status) {
      return res.status(400).json({ status: 'fail', message: 'Date and status are required.' });
    }

    // parseISO-style local date construction to avoid UTC shift
    const [year, month, day] = date.split('-').map(Number);
    const attendanceDate = new Date(year, month - 1, day);
    attendanceDate.setHours(0, 0, 0, 0);
    console.log(`[MANUAL] Marking ${status} for teacher ${teacherId || 'all'} on date: ${attendanceDate.toISOString()} (input: ${date})`);

    // Find the active term for this date and school
    const term = await Term.findOne({
      school: schoolId,
      startDate: { $lte: attendanceDate },
      endDate: { $gte: attendanceDate }
    });

    if (!term) {
      return res.status(400).json({ status: 'fail', message: 'No active term found for the selected date.' });
    }

    let teachersToUpdate = [];

    if (teacherId && teacherId !== 'all') {
      const teacher = await Teacher.findOne({ _id: teacherId, school: schoolId });
      if (!teacher) {
        return res.status(404).json({ status: 'fail', message: 'Teacher not found.' });
      }
      teachersToUpdate.push(teacher._id);
    } else {
      const allTeachers = await Teacher.find({ school: schoolId }, { _id: 1 }).lean();
      teachersToUpdate = allTeachers.map(t => t._id);
    }

    if (teachersToUpdate.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'No teachers found to update.' });
    }

    // 🔐 DE-DUPLICATION: Clear any existing records for these teachers on this day
    console.log(`[MANUAL] Clearing existing records for ${teachersToUpdate.length} teachers on ${date}`);
    await Attendance.deleteMany({
      teacher: { $in: teachersToUpdate },
      date: { $gte: attendanceDate, $lte: endOfDay(attendanceDate) }
    });

    const bulkOps = teachersToUpdate.map(tId => {
      const updateData = {
        $set: {
          teacher: tId,
          school: schoolId,
          term: term._id,
          date: attendanceDate,
          status: status
        }
      };

      // If Holiday or Absent, explicitly clear sign-in times and location
      if (status === 'Holiday' || status === 'Absent') {
        updateData.$set.signInTime = null;
        updateData.$set.signOutTime = null;
        updateData.$unset = { location: "" };
      }

      return {
        updateOne: {
          filter: { teacher: tId, date: attendanceDate },
          update: updateData,
          upsert: true
        }
      };
    });

    await Attendance.bulkWrite(bulkOps, { ordered: false });

    res.status(200).json({
      status: 'success',
      message: `Successfully marked ${status} for ${teachersToUpdate.length} teacher(s).`
    });

  } catch (err) {
    console.error('Mark manual attendance error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to mark manual attendance.' });
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
  markManualAttendance,
};