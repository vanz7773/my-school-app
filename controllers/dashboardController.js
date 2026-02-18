const mongoose = require('mongoose');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/StudentAttendance');
const Announcement = require('../models/Announcement');
const Grade = require('../models/Grade');
const Class = require('../models/Class');
// ... (MemoryCache class remains same)

// ...

exports.getStudentsByClass = async (req, res) => {
  const cacheKey = generateCacheKey('studentsByClass', req);
  // Clear cache for debugging or force refresh
  cache.del(cacheKey);

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const schoolId = new mongoose.Types.ObjectId(req.user.school);
    console.log("Fetching students by class for school:", schoolId);

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

    console.log("Students by class result:", result);

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

    const schoolId = new mongoose.Types.ObjectId(req.user.school);

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

    const schoolId = new mongoose.Types.ObjectId(req.user.school);

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
