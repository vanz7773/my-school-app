const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/StudentAttendance');
const Announcement = require('../models/Announcement');
const Grade = require('../models/Grade');
const Class = require('../models/Class');

// ---------------------------------------------------------
// 🧠 SIMPLE IN-MEMORY CACHE (NO REDIS ANYWHERE)
// ---------------------------------------------------------
class MemoryCache {
  constructor() {
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (item.expiry && Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  setex(key, ttl, value) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl * 1000
    });
  }

  del(key) {
    this.cache.delete(key);
  }

  delPattern(pattern) {
    const base = pattern.replace('*', '');
    for (const key of this.cache.keys()) {
      if (key.includes(base)) this.cache.delete(key);
    }
  }
}

// ALWAYS use memory cache (Redis removed)
const cache = new MemoryCache();

// ---------------------------------------------------------
// ⏱ CACHE TTL SETTINGS
// ---------------------------------------------------------
const CACHE_TTL = {
  DASHBOARD: 300,  // 5 minutes
  CHARTS: 2,       // 2 seconds (real-time updates)
  STATS: 900       // 15 minutes
};

const generateCacheKey = (prefix, req) =>
  `${prefix}:${req.user.school}:${req.user.role}:${req.user._id}`;

// ---------------------------------------------------------
// 🔔 BACKGROUND NOTIFICATION (optional)
// ---------------------------------------------------------
const sendDashboardNotification = (userId) => {
  setImmediate(() => {
    console.log(`Dashboard processing completed for user ${userId}`);
  });
};

// ---------------------------------------------------------
// 📊 MAIN DASHBOARD ENDPOINT
// ---------------------------------------------------------
exports.getDashboard = async (req, res) => {
  const { role, _id: userId, school: schoolId } = req.user;
  const cacheKey = generateCacheKey('dashboard', req);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    let result;

    if (role === 'admin') {
      result = await handleAdminDashboard(schoolId, userId);
    } else if (role === 'teacher') {
      result = await handleTeacherDashboard(schoolId, userId);
    } else if (role === 'student') {
      result = await handleStudentDashboard(userId);
    } else if (role === 'parent') {
      result = await handleParentDashboard(userId);
    } else {
      return res.status(403).json({ message: 'Dashboard not available for this role' });
    }

    cache.setex(cacheKey, CACHE_TTL.DASHBOARD, JSON.stringify(result));
    sendDashboardNotification(userId);

    res.json(result);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ message: 'Error fetching dashboard data', error: err.message });
  }
};

// ---------------------------------------------------------
// 📌 ADMIN DASHBOARD LOGIC
// ---------------------------------------------------------
const handleAdminDashboard = async (schoolId, userId) => {
  const [totalStudents, totalTeachers, totalParents, totalMessages] = await Promise.all([
    User.countDocuments({ role: 'student', school: schoolId }).lean(),
    User.countDocuments({ role: 'teacher', school: schoolId }).lean(),
    User.countDocuments({ role: 'parent', school: schoolId }).lean(),
    Announcement.countDocuments({ sentBy: userId }).lean()
  ]);

  return {
    role: 'admin',
    stats: { totalStudents, totalTeachers, totalParents, totalMessages }
  };
};

// ---------------------------------------------------------
// 📌 TEACHER DASHBOARD LOGIC
// ---------------------------------------------------------
const handleTeacherDashboard = async (schoolId, userId) => {
  const [teacher, classData] = await Promise.all([
    Teacher.findOne({ user: userId }).populate('user').lean(),
    Class.findOne({ teacher: userId, school: schoolId }).lean()
  ]);

  if (!classData) {
    return {
      role: 'teacher',
      stats: { class: 'Not Assigned', totalStudents: 0, attendanceToday: 0 }
    };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [students, attendanceToday] = await Promise.all([
    Student.countDocuments({ class: classData._id }).lean(),
    Attendance.countDocuments({
      class: classData._id,
      createdAt: { $gte: todayStart, $lt: todayEnd }
    }).lean()
  ]);

  return {
    role: 'teacher',
    stats: {
      class: classData.name,
      totalStudents: students,
      attendanceToday
    }
  };
};

// ---------------------------------------------------------
// 📌 STUDENT DASHBOARD LOGIC
// ---------------------------------------------------------
const handleStudentDashboard = async (userId) => {
  const student = await Student.findOne({ user: userId })
    .populate('class')
    .lean();

  if (!student) {
    return {
      role: 'student',
      stats: { totalAttendance: 0, class: 'Not Assigned' }
    };
  }

  const attendanceCount = await Attendance.countDocuments({ student: student._id }).lean();

  return {
    role: 'student',
    stats: {
      totalAttendance: attendanceCount,
      class: student.class?.name || 'Not Assigned'
    }
  };
};

// ---------------------------------------------------------
// 📌 PARENT DASHBOARD LOGIC
// ---------------------------------------------------------
const handleParentDashboard = async (userId) => {
  const children = await Student.find({ parent: userId })
    .populate('class user')
    .lean();

  const attendanceCounts = await Promise.all(
    children.map(child =>
      Attendance.countDocuments({ student: child._id }).lean()
    )
  );

  return {
    role: 'parent',
    stats: children.map((child, index) => ({
      name: child.user?.name || `Child ${index + 1}`,
      class: child.class?.name || 'Not Assigned',
      attendance: attendanceCounts[index]
    }))
  };
};

// ---------------------------------------------------------
// 📊 STUDENTS PER CLASS CHART
// ---------------------------------------------------------
exports.getStudentsByClass = async (req, res) => {
  const cacheKey = generateCacheKey('studentsByClass', req);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const schoolId = req.user.school;

    const result = await Student.aggregate([
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: '$classInfo' },
      { $match: { 'classInfo.school': schoolId } },
      {
        $group: {
          _id: '$classInfo._id',
          className: { $first: '$classInfo.name' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          className: 1,
          count: 1,
          _id: 0
        }
      }
    ]);

    cache.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('Students by class error:', err);
    res.status(500).json({ message: 'Error fetching students by class', error: err.message });
  }
};

// ---------------------------------------------------------
// 📚 AVERAGE GRADES CHART
// ---------------------------------------------------------
exports.getAverageGrades = async (req, res) => {
  const cacheKey = generateCacheKey('averageGrades', req);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const schoolId = req.user.school;

    const result = await Grade.aggregate([
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: '$classInfo' },
      { $match: { 'classInfo.school': schoolId } },
      {
        $group: {
          _id: '$classInfo._id',
          className: { $first: '$classInfo.name' },
          average: { $avg: '$score' }
        }
      },
      {
        $project: {
          className: 1,
          average: { $round: ['$average', 2] },
          _id: 0
        }
      }
    ]);

    cache.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('Average grades error:', err);
    res.status(500).json({ message: 'Error fetching average grades', error: err.message });
  }
};

// ---------------------------------------------------------
// 📅 WEEKLY ATTENDANCE CHART
// ---------------------------------------------------------
exports.getWeeklyAttendance = async (req, res) => {
  const cacheKey = generateCacheKey('weeklyAttendance', req);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const schoolId = req.user.school;

    const result = await Attendance.aggregate([
      {
        $match: {
          school: schoolId,
          week: { $exists: true },
          ...(req.query.termId ? { termId: new mongoose.Types.ObjectId(req.query.termId) } : {})
        }
      },
      {
        $group: {
          _id: { week: '$week', class: '$class' },
          totalRecords: { $sum: 1 },
          presentDays: {
            $push: {
              M: { $cond: [{ $eq: ['$days.M', 'present'] }, 1, 0] },
              T: { $cond: [{ $eq: ['$days.T', 'present'] }, 1, 0] },
              W: { $cond: [{ $eq: ['$days.W', 'present'] }, 1, 0] },
              TH: { $cond: [{ $eq: ['$days.TH', 'present'] }, 1, 0] },
              F: { $cond: [{ $eq: ['$days.F', 'present'] }, 1, 0] }
            }
          }
        }
      },
      {
        $project: {
          week: '$_id.week',
          classId: '$_id.class',
          dailyPercentages: {
            M: {
              $multiply: [
                { $divide: [{ $sum: '$presentDays.M' }, '$totalRecords'] },
                100
              ]
            },
            T: {
              $multiply: [
                { $divide: [{ $sum: '$presentDays.T' }, '$totalRecords'] },
                100
              ]
            },
            W: {
              $multiply: [
                { $divide: [{ $sum: '$presentDays.W' }, '$totalRecords'] },
                100
              ]
            },
            TH: {
              $multiply: [
                { $divide: [{ $sum: '$presentDays.TH' }, '$totalRecords'] },
                100
              ]
            },
            F: {
              $multiply: [
                { $divide: [{ $sum: '$presentDays.F' }, '$totalRecords'] },
                100
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'classes',
          localField: 'classId',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: '$classInfo' },
      {
        $group: {
          _id: '$week',
          classes: {
            $push: {
              className: '$classInfo.name',
              days: {
                M: { $round: '$dailyPercentages.M' },
                T: { $round: '$dailyPercentages.T' },
                W: { $round: '$dailyPercentages.W' },
                TH: { $round: '$dailyPercentages.TH' },
                F: { $round: '$dailyPercentages.F' }
              }
            }
          }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          week: '$_id',
          classes: 1,
          _id: 0
        }
      }
    ]);

    cache.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('Weekly attendance error:', err);
    res.status(500).json({ message: 'Error fetching weekly attendance', error: err.message });
  }
};

// ---------------------------------------------------------
// 🧹 MANUAL CACHE CLEAR
// ---------------------------------------------------------
exports.clearDashboardCache = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const patterns = [
      `dashboard:${schoolId}:`,
      `studentsByClass:${schoolId}:`,
      `averageGrades:${schoolId}:`,
      `weeklyAttendance:${schoolId}:`
    ];

    patterns.forEach(pattern => cache.delPattern(pattern));

    res.json({ message: 'Dashboard cache cleared successfully' });
  } catch (err) {
    console.error('Clear cache error:', err);
    res.status(500).json({ message: 'Error clearing cache', error: err.message });
  }
};

// ---------------------------------------------------------
// 🧪 CACHE HEALTH ENDPOINT
// ---------------------------------------------------------
exports.getCacheHealth = async (req, res) => {
  try {
    cache.setex('health-check', 10, 'OK');
    const value = cache.get('health-check');

    res.json({
      cacheStatus: value === 'OK' ? 'healthy' : 'degraded',
      cacheType: 'MemoryCache'
    });
  } catch (err) {
    res.json({
      cacheStatus: 'unavailable',
      cacheType: 'MemoryCache'
    });
  }
};
