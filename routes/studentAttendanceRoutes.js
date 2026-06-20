const express = require('express');
const router = express.Router();
const {
  initializeWeek,
  getWeeklySummary,
  getDailyBreakdown,
  getWeeklyAttendance,
  markAttendance,
  getMyAttendance,
  getStudentTermTotalAttendance, // ✅ ADD
  getClassTermAttendance // ✅ ADD
} = require('../controllers/studentAttendanceController');
const { protect } = require('../middlewares/authMiddleware');
const { checkPermissionForAdmin } = require('../middlewares/permissionMiddleware');

// initialize week
router.post('/initialize-week', protect, checkPermissionForAdmin('canEditAttendance'), initializeWeek);

// mark attendance
router.post('/mark', protect, checkPermissionForAdmin('canEditAttendance'), markAttendance);

// weekly summary (raw documents)
router.get('/weekly-summary', protect, checkPermissionForAdmin('canViewAttendance'), getWeeklySummary);

// daily breakdown
router.get('/by-class', protect, checkPermissionForAdmin('canViewAttendance'), getDailyBreakdown);

// New route: get logged-in student's attendance
router.get('/my', protect, getMyAttendance);

// ✅ NEW: total attendance for a student in a term
// GET /api/attendance/student/term-total?studentId=...&termId=...
router.get('/student/term-total', protect, checkPermissionForAdmin('canViewAttendance'), getStudentTermTotalAttendance);

// ✅ NEW: class term attendance
router.get('/class/term', protect, checkPermissionForAdmin('canViewAttendance'), getClassTermAttendance);

// GET /api/attendance/:classId?week=Week%201&term=Term%201&year=2025
router.get('/:classId', protect, checkPermissionForAdmin('canViewAttendance'), getWeeklyAttendance);

module.exports = router;
