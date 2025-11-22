/**
 * routes/teacherAttendanceRoutes.js
 * -------------------------------------------------
 * Defines all teacher and admin endpoints for attendance management.
 * 
 * Geofence validation is automatically applied inside the controller
 * via withGeofenceValidation(clockAttendance) — no need to import
 * the middleware directly here.
 */

const express = require('express');
const router = express.Router();

const {
  clockAttendance,
  getTodayAttendance,
  getMissedClockouts,
  getTeacherDailyRecords,
  getAdminDailyRecords,
  getTeacherWeeklySummary,
  getAdminWeeklySummary,
  getTeacherMonthlySummary,
  getAdminMonthlySummary,
  getTeacherAttendanceHistory,
  getAdminAttendanceHistory,
} = require('../controllers/teacherAttendanceController');

const { protect, restrictTo } = require('../middlewares/authMiddleware');

// ─────────────────────────────────────────────────────────────
// 🧑‍🏫 TEACHER ROUTES
// ─────────────────────────────────────────────────────────────

// ✅ Clock-in/out (geofence validation runs inside controller)
router.post('/clock', protect, restrictTo('teacher'), clockAttendance);

// ✅ Teacher’s daily and missed clockouts
router.get('/today', protect, restrictTo('teacher'), getTodayAttendance);
router.get('/missed', protect, restrictTo('teacher'), getMissedClockouts);

// ✅ Teacher attendance records
router.get(
  '/daily-records',
  protect,
  restrictTo('teacher'),
  (req, res, next) => {
    console.log('REQ.USER:', req.user);
    next();
  },
  getTeacherDailyRecords
);

router.get('/weekly-summary', protect, restrictTo('teacher'), getTeacherWeeklySummary);
router.get('/monthly-summary', protect, restrictTo('teacher'), getTeacherMonthlySummary);
router.get('/history', protect, restrictTo('teacher'), getTeacherAttendanceHistory);

// ─────────────────────────────────────────────────────────────
// 🛠️ ADMIN ROUTES
// ─────────────────────────────────────────────────────────────

router.get('/admin/daily-records', protect, restrictTo('admin'), getAdminDailyRecords);
router.get('/admin/weekly-summary', protect, restrictTo('admin'), getAdminWeeklySummary);
router.get('/admin/monthly-summary', protect, restrictTo('admin'), getAdminMonthlySummary);
router.get('/admin/history', protect, restrictTo('admin'), getAdminAttendanceHistory);

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

module.exports = router;
