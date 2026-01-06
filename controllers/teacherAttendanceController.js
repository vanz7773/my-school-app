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

const backfillTermAbsencesIfNeeded = async (teacher, term) => {
  const termStart = startOfDay(new Date(term.startDate));

  const yesterday = startOfDay(new Date());
  yesterday.setDate(yesterday.getDate() - 1);

  const termEnd = new Date(
    Math.min(yesterday.getTime(), new Date(term.endDate).getTime())
  );

  if (termEnd < termStart) return;

  const bulkOps = [];
  let cursor = new Date(termStart);

  while (cursor <= termEnd) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      const date = startOfDay(new Date(cursor));

      bulkOps.push({
        updateOne: {
          filter: {
            teacher: teacher._id,
            term: term._id,
            date
          },
          update: {
            $setOnInsert: {
              teacher: teacher._id,
              school: teacher.school,
              term: term._id,
              date,
              signInTime: null,
              signOutTime: null,
              status: "Absent"
            }
          },
          upsert: true
        }
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (bulkOps.length) {
    await Attendance.bulkWrite(bulkOps, { ordered: false });
  }
};





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
// CLOCK IN / OUT (PRODUCTION CLEAN VERSION)
// ─────────────────────────────────────────────────────────────
const clockAttendance = async (req, res) => {
  const { teacherId, type, timestamp, date, termId, deviceUUID, latitude, longitude } = req.body;
  const isAdmin = req.user.role === "admin";

  // Validate input
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

  if (!latitude || !longitude) {
    return res.status(400).json({
      status: "fail",
      message: "Location not detected. Please enable GPS and try again.",
    });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({
      status: "fail",
      message: "Invalid location detected. Please move to an open space and try again.",
    });
  }

  try {
    // 1️⃣ TERM LOOKUP
    const term = await Term.findById(termId);
    if (!term) {
      return res.status(404).json({
        status: "fail",
        message: "Term not found. Please refresh and select a valid term.",
      });
    }

    // 2️⃣ TEACHER LOOKUP
    let teacher;
    try {
      if (teacherId && isAdmin) {
        teacher = await Teacher.findById(teacherId).populate("school user");
      } else {
        const userObjId =
          typeof req.user.id === "string"
            ? new mongoose.Types.ObjectId(req.user.id)
            : req.user.id;

        teacher = await Teacher.findOne({ user: userObjId }).populate("school user");
      }
    } catch (err) {
      return res.status(500).json({
        status: "error",
        message: "Something went wrong while verifying your account.",
      });
    }

    if (!teacher) {
      return res.status(404).json({
        status: "fail",
        message: "Teacher record not found. Contact your administrator.",
      });
    }

    if (!teacher.school) {
      return res.status(404).json({
        status: "fail",
        message: "You are not assigned to any school. Contact your administrator.",
      });
    }

    // 3️⃣ DEVICE BINDING
    let registeredDevice = null;

    try {
      const existingByDevice = await DeviceBinding.findOne({ deviceUUID });

      if (existingByDevice) {
        if (existingByDevice.teacher.equals(teacher._id)) {
          registeredDevice = existingByDevice;
        } else {
          return res.status(403).json({
            status: "fail",
            message: "This device belongs to another teacher. Please contact your admin.",
          });
        }
      } else {
        const existingByTeacher = await DeviceBinding.findOne({ teacher: teacher._id });

        if (!existingByTeacher) {
          registeredDevice = await DeviceBinding.create({
            teacher: teacher._id,
            deviceUUID,
          });
        } else {
          if (existingByTeacher.deviceUUID !== deviceUUID) {
            return res.status(403).json({
              status: "fail",
              message:
                "Your account is linked to a different device. Contact your admin to reset your device.",
            });
          }
          registeredDevice = existingByTeacher;
        }
      }
    } catch (err) {
      return res.status(500).json({
        status: "error",
        message: "Device verification failed. Try again.",
      });
    }

    // 4️⃣ ATTENDANCE LOGIC
    const attendanceDate = date ? new Date(date) : clockTime;
    const dayStart = startOfDay(attendanceDate);
    const dayEnd = endOfDay(attendanceDate);

    let attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: dayStart, $lte: dayEnd },
    });

    // 🔒 Block clock-in ONLY if Absent AFTER school hours
if (attendance && attendance.status === "Absent" && type === "in" && !isAdmin) {
  const now = new Date();
  const dayStart = startOfDay(now);

  // ⏰ Must match absentee logic
  const SCHOOL_END_HOUR = 15;
  const SCHOOL_END_MINUTE = 30;

  const schoolEnd = new Date(dayStart);
  schoolEnd.setHours(SCHOOL_END_HOUR, SCHOOL_END_MINUTE, 0, 0);

  // ❌ Block ONLY after school has closed
  if (now >= schoolEnd) {
    return res.status(403).json({
      status: "fail",
      message:
        "You were marked absent for today. Clock-in is no longer allowed. Please contact the administrator.",
    });
  }

  // ✅ Before school close → allow clock-in and FIX the record
  attendance.status = "On Time";
  attendance.signInTime = clockTime;
}


    const lateThreshold = new Date(dayStart);
    lateThreshold.setHours(8, 0, 0, 0);

    if (!attendance) {
      attendance = new Attendance({
        teacher: teacher._id,
        school: teacher.school._id,
        date: attendanceDate,
        term: term._id,
        signInTime: type === "in" ? clockTime : null,
        signOutTime: type === "out" ? clockTime : null,
        status:
          type === "in"
            ? clockTime > lateThreshold
              ? "Late"
              : "On Time"
            : "On Time",
        location: { type: "Point", coordinates: [lng, lat] },
      });
    } else {
      if (type === "in") {
        if (attendance.signInTime) {
          return res.status(400).json({
            status: "fail",
            message: "You have already clocked in today.",
          });
        }
        attendance.signInTime = clockTime;
        attendance.status = clockTime > lateThreshold ? "Late" : "On Time";
      } else {
        if (!attendance.signInTime) {
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

      attendance.location = { type: "Point", coordinates: [lng, lat] };
      attendance.term = term._id;
    }

    await attendance.save();

    // 5️⃣ CREATE NOTIFICATION
    const teacherName = teacher.user?.name || "Teacher";
    const actionType = type === "in" ? "clocked in" : "clocked out";
    const statusMessage = attendance.status === "Late" ? " (Late)" : "";

    await Notification.create({
  sender: req.user._id,
  school: req.user.school,
  title: `Teacher ${actionType.charAt(0).toUpperCase() + actionType.slice(1)}`,
  message: `${teacherName} ${actionType}${statusMessage}`,
  type: "teacher-attendance",

  // 🔒 FIXED TARGETING
  audience: "teacher",
  recipientRoles: ["admin"],     // 👈 admins only
  recipientUsers: [teacher.user] // 👈 only the acting teacher
});


    // 6️⃣ SEND PUSH
    const adminUsers = await mongoose.model("User").find({
      school: teacher.school._id,
      role: "admin",
    }).select("_id");

    const adminIds = adminUsers.map((a) => String(a._id));
    const teacherUserId = teacher.user?._id ? String(teacher.user._id) : null;
    const pushRecipients = [...(teacherUserId ? [teacherUserId] : []), ...adminIds];

    try {
      await sendPush(
        pushRecipients,
        `Attendance ${type === "in" ? "Clock In" : "Clock Out"}`,
        `${teacherName} ${actionType}${statusMessage}`,
        {
          teacherId: String(teacher._id),
          action: type,
          time: clockTime,
        }
      );
    } catch (_) {}

    // FINAL RESPONSE
    return res.status(200).json({
      status: "success",
      data: {
        attendance,
        message:
          type === "in"
            ? "Clock-in successful. Have a great day!"
            : "Clock-out successful. Goodbye!",
        geofenceStatus: req.geofenceStatus || "validated",
        distanceFromCenter: req.geofenceData?.distanceFromCenter || null,
        teacherId: teacher._id,
      },
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Something went wrong. Please try again.",
    });
  }
};




// ─────────────────────────────────────────────────────────────
// TEACHER DAILY RECORDS (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getTeacherDailyRecords = async (req, res) => {
  console.log('=== GET TEACHER DAILY RECORDS STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // This endpoint must be READ-ONLY

    const teacher = await Teacher.findOne({ user: req.user.id })
      .populate({
        path: 'school',
        match: { _id: { $exists: true } }
      });

    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    if (!teacher.school) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher is not assigned to a school.'
      });
    }

    const { termId } = req.query;

    // ✅ Resolve term safely
    let term;

    if (termId) {
      term = await Term.findOne({
        _id: termId,
        school: teacher.school._id
      });
    } else {
      const today = startOfDay(new Date());

      term = await Term.findOne({
        school: teacher.school._id,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Term-scoped, safe query
    const records = await Attendance.find({
      teacher: teacher._id,
      term: term._id
    })
      .sort({ date: -1 })
      .limit(30);

    console.log('Records found:', records.length);

    return res.status(200).json({
      status: 'success',
      data: records
    });

  } catch (err) {
    console.error('Teacher daily records error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch daily records'
    });
  } finally {
    console.log('=== GET TEACHER DAILY RECORDS COMPLETED ===');
  }
};



// ─────────────────────────────────────────────────────────────
// ADMIN DAILY RECORDS (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getAdminDailyRecords = async (req, res) => {
  console.log('=== GET ADMIN DAILY RECORDS STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // This endpoint must be READ-ONLY

    const { teacherId, from, to, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId) {
      match.teacher = new mongoose.Types.ObjectId(teacherId);
    }

    if (from && to) {
      match.date = {
        $gte: startOfDay(new Date(from)),
        $lte: endOfDay(new Date(to))
      };
    }

    // ✅ Resolve term safely
    let term;

    if (termId) {
      term = await Term.findOne({
        _id: termId,
        school: req.user.school
      });
    } else {
      const today = startOfDay(new Date());

      term = await Term.findOne({
        school: req.user.school,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Enforce term isolation
    match.term = term._id;

    const records = await Attendance.find(match)
      .populate({
        path: 'teacher',
        populate: { path: 'user', select: 'name' }
      })
      .sort({ date: -1 });

    console.log('Records found:', records.length);

    // Weekly chart calculation (UNCHANGED)
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

    return res.status(200).json({
      status: 'success',
      data: {
        records,
        weeklyChart
      }
    });

  } catch (err) {
    console.error('Admin daily records error:', err);
    return res.status(500).json({
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
// ADMIN WEEKLY SUMMARY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getAdminWeeklySummary = async (req, res) => {
  console.log('=== GET ADMIN WEEKLY SUMMARY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // This endpoint must NEVER mutate attendance

    const { teacherId, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId) {
      match.teacher = new mongoose.Types.ObjectId(teacherId);
      console.log('Filtering by teacher ID:', teacherId);
    }

    // ✅ Resolve term (explicit or current)
    let term;
    let termWeeks = [];

    if (termId) {
      term = await Term.findOne({
        _id: termId,
        school: req.user.school
      });
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: req.user.school,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Enforce term isolation
    match.term = term._id;

    // Pre-calc weeks (used for labeling only)
    termWeeks = calculateTermWeeks(term.startDate, term.endDate);
    console.log('Calculated term weeks:', termWeeks.length);

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
          present: {
            $sum: {
              $cond: [{ $in: ["$status", ["On Time", "Late"]] }, 1, 0]
            }
          },
          late: {
            $sum: {
              $cond: [{ $eq: ["$status", "Late"] }, 1, 0]
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

    // ✅ Attach week numbers safely
    const summaryWithWeekNumbers = summary.map(week => {
      const matchingTermWeek = termWeeks.find(
        w => new Date(w.startDate).toISOString() === new Date(week.weekStart).toISOString()
      );

      return {
        ...week,
        weekNumber: matchingTermWeek?.weekNumber || null,
        weekLabel: matchingTermWeek
          ? `Week ${matchingTermWeek.weekNumber}`
          : 'Unknown Week'
      };
    });

    return res.status(200).json({
      status: 'success',
      data: {
        termWeeks,
        attendance: summaryWithWeekNumbers
      }
    });

  } catch (err) {
    console.error('Admin weekly summary error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch weekly summary'
    });
  } finally {
    console.log('=== GET ADMIN WEEKLY SUMMARY COMPLETED ===');
  }
};



// ─────────────────────────────────────────────────────────────
// TEACHER WEEKLY SUMMARY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getTeacherWeeklySummary = async (req, res) => {
  console.log('=== GET TEACHER WEEKLY SUMMARY STARTED ===');
  console.log('Query params:', req.query);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // Weekly summary must NEVER mutate attendance

    const teacher = await Teacher.findOne({ user: req.user.id }).populate('school');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const { termId } = req.query;
    let term;

    // ✅ Resolve term safely (explicit or by date)
    if (termId) {
      term = await Term.findById(termId);
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: teacher.school._id,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    const termStart = new Date(term.startDate);
    const termEnd = new Date(term.endDate);

    console.log('Term date range:', termStart, 'to', termEnd);

    // ✅ TERM-ISOLATED, READ-ONLY QUERY
    const attendanceData = await Attendance.find({
      teacher: teacher._id,
      term: term._id,
      date: {
        $gte: termStart,
        $lte: termEnd,
        $type: 'date'
      }
    })
      .sort({ date: 1 })
      .lean();

    // Group by consistent week numbers
    const weeklySummary = {};
    const millisecondsPerWeek = 7 * 24 * 60 * 60 * 1000;

    attendanceData.forEach(record => {
      const recordDate = new Date(record.date);

      const weekNumber =
        Math.floor((recordDate - termStart) / millisecondsPerWeek) + 1;

      const maxWeeks = Math.ceil((termEnd - termStart) / millisecondsPerWeek);
      const boundedWeek = Math.max(1, Math.min(weekNumber, maxWeeks));

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

      if (['On Time', 'Late'].includes(record.status)) {
        weeklySummary[boundedWeek].present++;
      }

      if (record.status === 'Late') {
        weeklySummary[boundedWeek].late++;
      }
    });

    // Convert to array and sort (most recent week first)
    const result = Object.values(weeklySummary).sort((a, b) => b.week - a.week);

    console.log('Weekly summary generated:', result.length, 'weeks');

    return res.status(200).json({
      status: 'success',
      data: result
    });

  } catch (err) {
    console.error('Teacher weekly summary error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch weekly summary'
    });
  } finally {
    console.log('=== GET TEACHER WEEKLY SUMMARY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// TEACHER MONTHLY SUMMARY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getTeacherMonthlySummary = async (req, res) => {
  console.log('=== GET TEACHER MONTHLY SUMMARY STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // Monthly summary must NEVER mutate attendance

    const teacher = await Teacher.findOne({ user: req.user.id }).populate('school');
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const { termId } = req.query;

    // ✅ Resolve term (explicit or current)
    let term;

    if (termId) {
      term = await Term.findById(termId);
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: teacher.school._id,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    const summary = await Attendance.aggregate([
      {
        $match: {
          teacher: teacher._id,
          term: term._id
        }
      },
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

    return res.status(200).json({
      status: 'success',
      data: summary
    });

  } catch (err) {
    console.error('Teacher monthly summary error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch monthly summary'
    });
  } finally {
    console.log('=== GET TEACHER MONTHLY SUMMARY COMPLETED ===');
  }
};



// ─────────────────────────────────────────────────────────────
// ADMIN MONTHLY SUMMARY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getAdminMonthlySummary = async (req, res) => {
  console.log('=== GET ADMIN MONTHLY SUMMARY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // Monthly summary must NEVER mutate attendance

    const { teacherId, from, to, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
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

    // ✅ Resolve term (explicit or current)
    let term;

    if (termId) {
      term = await Term.findOne({
        _id: termId,
        school: req.user.school
      });
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: req.user.school,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Enforce term isolation
    match.term = term._id;

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

    return res.status(200).json({
      status: 'success',
      data: summary
    });

  } catch (err) {
    console.error('Admin monthly summary error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch monthly summary'
    });
  } finally {
    console.log('=== GET ADMIN MONTHLY SUMMARY COMPLETED ===');
  }
};


// ─────────────────────────────────────────────────────────────
// TEACHER TODAY'S ATTENDANCE (TERM-SAFE, READ-ONLY)
// ─────────────────────────────────────────────────────────────
const getTodayAttendance = async (req, res) => {
  console.log('=== GET TODAY ATTENDANCE STARTED ===');
  console.log('User ID:', req.user.id);

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

    // 🕘 School hours
    const SCHOOL_START_HOUR = 8;
    const SCHOOL_START_MINUTE = 0;
    const SCHOOL_END_HOUR = 15;
    const SCHOOL_END_MINUTE = 30;

    const schoolStart = new Date(todayStart);
    schoolStart.setHours(SCHOOL_START_HOUR, SCHOOL_START_MINUTE, 0, 0);

    const schoolEnd = new Date(todayStart);
    schoolEnd.setHours(SCHOOL_END_HOUR, SCHOOL_END_MINUTE, 0, 0);

    // ✅ Resolve CURRENT TERM FIRST (CRITICAL)
    const currentTerm = await Term.findOne({
      school: teacher.school,
      startDate: { $lte: todayStart },
      endDate: { $gte: todayStart }
    });

    if (!currentTerm) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Fetch attendance STRICTLY for this term
    const attendance = await Attendance.findOne({
      teacher: teacher._id,
      term: currentTerm._id,
      date: { $gte: todayStart, $lte: todayEnd }
    });

    // 🧠 Status resolution (NO side effects)
    let status;

    if (!attendance) {
      if (now < schoolStart) {
        status = 'Not Started';
      } else if (now >= schoolStart && now < schoolEnd) {
        status = 'Pending';
      } else {
        status = 'Absent';
      }
    } else {
      status = attendance.status;
    }

    return res.status(200).json({
      status: 'success',
      data: {
        termId: currentTerm._id,
        clockedIn: !!attendance?.signInTime,
        clockedOut: !!attendance?.signOutTime,
        status,
        lastAction: attendance?.signOutTime || attendance?.signInTime
      }
    });

  } catch (err) {
    console.error('Today attendance error:', err);
    return res.status(500).json({
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
// TEACHER ATTENDANCE HISTORY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getTeacherAttendanceHistory = async (req, res) => {
  console.log('=== GET TEACHER ATTENDANCE HISTORY STARTED ===');
  console.log('User ID:', req.user.id);

  try {
    // ❌ REMOVED:
    // markAbsenteesForTodayIfNeeded()
    // backfillTermAbsencesIfNeeded()
    // This endpoint must be READ-ONLY

    const teacher = await Teacher.findOne({ user: req.user.id });
    console.log('Teacher found:', teacher ? teacher._id : 'None');

    if (!teacher) {
      return res.status(404).json({
        status: 'fail',
        message: 'Teacher not found'
      });
    }

    const { termId } = req.query;

    // ✅ Resolve term safely
    let term;

    if (termId) {
      term = await Term.findById(termId);
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: teacher.school,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Term-isolated, read-only query
    const history = await Attendance.find({
      teacher: teacher._id,
      term: term._id
    })
      .sort({ date: -1 })
      .select('date signInTime signOutTime status location')
      .limit(30);

    console.log('History records found:', history.length);

    return res.status(200).json({
      status: 'success',
      data: history
    });

  } catch (err) {
    console.error('Attendance history error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch attendance history'
    });
  } finally {
    console.log('=== GET TEACHER ATTENDANCE HISTORY COMPLETED ===');
  }
};




// ─────────────────────────────────────────────────────────────
// ADMIN ATTENDANCE HISTORY (READ-ONLY, TERM-SAFE)
// ─────────────────────────────────────────────────────────────
const getAdminAttendanceHistory = async (req, res) => {
  console.log('=== GET ADMIN ATTENDANCE HISTORY STARTED ===');
  console.log('Query parameters:', req.query);
  console.log('User school:', req.user.school);

  try {
    // ❌ REMOVED: markAbsenteesForTodayIfNeeded()
    // Admin history must NEVER mutate attendance

    const { teacherId, termId } = req.query;
    const filter = { school: req.user.school };

    if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
      filter.teacher = new mongoose.Types.ObjectId(teacherId);
      console.log('Filtering by teacher ID:', teacherId);
    }

    // ✅ Resolve term (explicit or current)
    let term;

    if (termId) {
      term = await Term.findOne({
        _id: termId,
        school: req.user.school
      });
    } else {
      const today = startOfDay(new Date());
      term = await Term.findOne({
        school: req.user.school,
        startDate: { $lte: today },
        endDate: { $gte: today }
      });
    }

    if (!term) {
      return res.status(404).json({
        status: 'fail',
        message: 'No active term found'
      });
    }

    // ✅ Enforce term isolation
    filter.term = term._id;

    const history = await Attendance.find(filter)
      .populate({
        path: 'teacher',
        populate: { path: 'user', select: 'name' }
      })
      .sort({ date: -1 });

    console.log('History records found:', history.length);

    return res.status(200).json({
      status: 'success',
      data: history
    });

  } catch (err) {
    console.error('Admin attendance history error:', err);
    return res.status(500).json({
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