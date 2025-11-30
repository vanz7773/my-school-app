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
// CLOCK IN / OUT (NOW USES GEOFENCE MIDDLEWARE)
// ─────────────────────────────────────────────────────────────
const clockAttendance = async (req, res) => {
  console.log('=== CLOCK ATTENDANCE STARTED ===');
  const { teacherId, type, timestamp, date, termId, deviceUUID, latitude, longitude } = req.body;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin'; // ✅ Supervisor removed

  console.log('Request body:', { teacherId, type, timestamp, date, termId, deviceUUID, latitude, longitude });

  // Validate type
  if (!['in', 'out'].includes(type))
    return res.status(400).json({ status: 'fail', message: 'Invalid type. Must be "in" or "out".' });

  const clockTime = new Date(timestamp);
  if (isNaN(clockTime.getTime()))
    return res.status(400).json({ status: 'fail', message: 'Invalid timestamp.' });

  if (!deviceUUID)
    return res.status(400).json({ status: 'fail', message: 'Device UUID is required.' });

  // Validate coordinates
  if (!latitude || !longitude)
    return res.status(400).json({ status: 'fail', message: 'Latitude and longitude are required.' });

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lng))
    return res.status(400).json({ status: 'fail', message: 'Invalid latitude or longitude values.' });

  try {
    // 1️⃣ Fetch term
    const term = await Term.findById(termId);
    if (!term)
      return res.status(404).json({ status: 'fail', message: 'Term not found.' });

    // 2️⃣ Fetch teacher
    let teacher;
    try {
      console.log('Attempting teacher lookup. teacherId (body):', teacherId, 'req.user:', req.user);
      if (teacherId && isAdmin) {
        // ✅ Only admins can clock for other teachers
        teacher = await Teacher.findById(teacherId).populate('school user');
        console.log('Admin-provided teacher lookup result:', teacher ? teacher._id : null);
      } else {
        if (!req.user || !req.user.id)
          return res.status(401).json({ status: 'fail', message: 'Not authenticated.' });

        const userObjectId =
          typeof req.user.id === 'string'
            ? new mongoose.Types.ObjectId(req.user.id)
            : req.user.id;

        teacher = await Teacher.findOne({ user: userObjectId }).populate('school user');
        console.log('Teacher lookup by req.user result:', teacher ? teacher._id : null);
      }
    } catch (lookupErr) {
      console.error('Teacher lookup error:', lookupErr);
      return res.status(500).json({ status: 'error', message: 'Failed to lookup teacher' });
    }

    if (!teacher)
      return res.status(404).json({
        status: 'fail',
        message:
          teacherId && isAdmin
            ? 'Teacher not found for provided teacherId.'
            : 'Teacher record not found for authenticated user.',
      });

    if (!teacher.school)
      return res.status(404).json({ status: 'fail', message: 'Teacher is not assigned to a school.' });

    // ✅ Geofence validation handled by middleware
    console.log('Geofence validated via middleware:', req.geofenceStatus || 'unknown');

    // 4️⃣ Device Binding Enforcement
    let registeredDevice = null;
    try {
      const existingByDevice = await DeviceBinding.findOne({ deviceUUID });

      if (existingByDevice) {
        if (existingByDevice.teacher.equals(teacher._id)) {
          registeredDevice = existingByDevice;
        } else {
          return res.status(403).json({
            status: 'fail',
            message: 'This device is already registered to another teacher.',
          });
        }
      } else {
        const existingByTeacher = await DeviceBinding.findOne({ teacher: teacher._id });
        if (!existingByTeacher) {
          try {
            registeredDevice = await DeviceBinding.create({
              teacher: teacher._id,
              deviceUUID,
            });
            console.log(`Device ${deviceUUID} registered for teacher ${teacher._id}`);
          } catch (createErr) {
            if (createErr.code === 11000) {
              const conflict = await DeviceBinding.findOne({ deviceUUID });
              if (conflict && !conflict.teacher.equals(teacher._id)) {
                return res.status(403).json({
                  status: 'fail',
                  message: 'Device just registered to another teacher.',
                });
              }
              registeredDevice = await DeviceBinding.findOne({ teacher: teacher._id });
              if (!registeredDevice) throw createErr;
            } else {
              throw createErr;
            }
          }
        } else {
          if (existingByTeacher.deviceUUID !== deviceUUID) {
            return res.status(403).json({
              status: 'fail',
              message:
                'Your account is already registered to a different device. Contact your admin to rebind your device.',
            });
          }
          registeredDevice = existingByTeacher;
        }
      }
    } catch (err) {
      console.error('Device binding check error:', err);
      return res.status(500).json({ status: 'error', message: 'Device binding error' });
    }

    console.log('Device binding result:', {
      registeredDeviceExists: !!registeredDevice,
      registeredDeviceId: registeredDevice?._id?.toString?.() ?? null,
      registeredDeviceTeacher: registeredDevice?.teacher?.toString?.() ?? null,
      incomingDeviceUUID: deviceUUID,
      teacherId: teacher._id.toString(),
    });

    // 5️⃣ Attendance Logic
    const attendanceDate = date ? new Date(date) : clockTime;
    const dayStart = startOfDay(attendanceDate);
    const dayEnd = endOfDay(attendanceDate);

    let attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: dayStart, $lte: dayEnd },
    });

    const lateThreshold = new Date(dayStart);
    lateThreshold.setHours(8, 0, 0, 0);

    if (!attendance) {
      attendance = new Attendance({
        teacher: teacher._id,
        school: teacher.school._id,
        date: attendanceDate,
        term: term._id,
        signInTime: type === 'in' ? clockTime : null,
        signOutTime: type === 'out' ? clockTime : null,
        status:
          type === 'in'
            ? clockTime > lateThreshold
              ? 'Late'
              : 'On Time'
            : 'On Time',
        location: { type: 'Point', coordinates: [lng, lat] },
      });
    } else {
      if (type === 'in') {
        if (attendance.signInTime)
          return res.status(400).json({ status: 'fail', message: 'Already clocked in today.' });
        attendance.signInTime = clockTime;
        attendance.status = clockTime > lateThreshold ? 'Late' : 'On Time';
      } else {
        if (!attendance.signInTime)
          return res.status(400).json({ status: 'fail', message: 'Must clock in before clocking out.' });
        if (attendance.signOutTime)
          return res.status(400).json({ status: 'fail', message: 'Already clocked out today.' });
        attendance.signOutTime = clockTime;
      }
      attendance.location = { type: 'Point', coordinates: [lng, lat] };
      attendance.term = term._id;
    }

    await attendance.save();

// 🔔 CREATE NOTIFICATION FOR ATTENDANCE
const teacherName = teacher.user?.name || "Teacher";
const actionType = type === "in" ? "clocked in" : "clocked out";
const statusMessage = attendance.status === "Late" ? " (Late)" : "";

// 🔔 IN-APP NOTIFICATION (teachers + admins)
await Notification.create({
  sender: req.user._id,
  school: req.user.school,
  title: `Teacher ${actionType.charAt(0).toUpperCase() + actionType.slice(1)}`,
  message: `${teacherName} ${actionType}${statusMessage}`,
  type: "teacher-attendance",
  audience: "teacher",
  recipientRoles: ["teacher", "admin"],
  recipientUsers: []
});

// 🔔 PUSH NOTIFICATION TARGETS
// Find admins in the same school (correct lookup using User.role)
const adminUsers = await Teacher.aggregate([
  { $match: { school: teacher.school._id } },

  {
    $lookup: {
      from: "users",
      localField: "user",
      foreignField: "_id",
      as: "user"
    }
  },
  { $unwind: "$user" },

  // ❗ Correct filter → admins are in USER.role, not teacher.role
  { $match: { "user.role": "admin" } },

  { $project: { userId: "$user._id" } }
]);

const adminIds = adminUsers.map(a => String(a.userId));

// Teacher also receives push
const teacherUserId = teacher.user?._id ? String(teacher.user._id) : null;

const pushRecipients = [
  ...(teacherUserId ? [teacherUserId] : []),
  ...adminIds
];

// 🔔 SEND PUSH
await sendPush(
  pushRecipients,
  `Attendance ${type === "in" ? "Clock In" : "Clock Out"}`,
  `${teacherName} ${actionType}${statusMessage}`,
  {
    teacherId: String(teacher._id),
    action: type,
    time: clockTime
  }
);



    // ✅ Extract distance info from geofence middleware
    const { geofenceStatus, geofenceData } = req;
    const distanceFromCenter = geofenceData?.distanceFromCenter || null;

    return res.status(200).json({
      status: 'success',
      data: {
        attendance,
        message: `Successfully clocked ${type} for ${teacher.user?.name || 'teacher'}`,
        geofenceStatus: geofenceStatus || 'validated',
        distanceFromCenter, // ✅ Added for mobile app display
        teacherId: teacher._id,
      },
    });
  } catch (err) {
    console.error('Clock attendance error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
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
    const { teacherId, from, to, termId } = req.query;
    const match = { school: req.user.school };

    if (teacherId) match.teacher = new mongoose.Types.ObjectId(teacherId);
    if (from && to) match.date = { $gte: startOfDay(new Date(from)), $lte: endOfDay(new Date(to)) };
    if (termId) {
      const term = await Term.findOne({ _id: termId, school: req.user.school });
      if (!term) return res.status(404).json({ status: 'fail', message: 'Term not found' });
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
      let percentage = 0;
      
      if (dayData.total > 0) {
        percentage = Math.round((dayData.present / dayData.total) * 100);
      }
      
      return {
        day,
        presentPercentage: percentage,
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
    res.status(500).json({ status: 'error', message: 'Failed to fetch daily records' });
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
      console.log('Calculated term weeks:', termWeeks.length);
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
// TEACHER TODAY'S ATTENDANCE
// ─────────────────────────────────────────────────────────────
const getTodayAttendance = async (req, res) => {
  console.log('=== GET TODAY ATTENDANCE STARTED ===');
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

    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    console.log('Today date range:', { todayStart, todayEnd });

    const attendance = await Attendance.findOne({
      teacher: teacher._id,
      date: { $gte: todayStart, $lte: todayEnd },
    });

    console.log('Today attendance:', attendance);

    res.status(200).json({ 
      status: 'success',
      data: {
        clockedIn: !!attendance?.signInTime,
        clockedOut: !!attendance?.signOutTime,
        status: attendance?.status || 'Absent',
        lastAction: attendance?.signOutTime || attendance?.signInTime
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