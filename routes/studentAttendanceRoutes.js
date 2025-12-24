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
} = require('../controllers/studentAttendanceController');
const { protect } = require('../middlewares/authMiddleware');

// initialize week
router.post('/initialize-week', protect, initializeWeek);

// mark attendance
router.post('/mark', protect, markAttendance);

// weekly summary (raw documents)
router.get('/weekly-summary', protect, getWeeklySummary);

// daily breakdown
router.get('/by-class', protect, getDailyBreakdown);

// New route: get logged-in student's attendance
router.get('/my', protect, getMyAttendance);

// ✅ NEW: total attendance for a student in a term
// GET /api/attendance/student/term-total?studentId=...&termId=...
router.get('/student/term-total', protect, getStudentTermTotalAttendance);

// GET /api/attendance/:classId?week=Week%201&term=Term%201&year=2025
router.get('/:classId', protect, getWeeklyAttendance);

module.exports = router;
