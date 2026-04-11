const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  getDashboard,
  getStudentsByClass,
  getAverageGrades,
  getWeeklyAttendance,
  getFeesCollectionDashboard
} = require('../controllers/dashboardController');

// 👤 Dashboard summary based on user role
router.get('/', protect, getDashboard);

// 📊 For "Students per Class" chart (Pie)
router.get('/students-by-class', protect, getStudentsByClass);

// 📊 For "Average Grades per Class" chart (Bar)
router.get('/average-grades', protect, getAverageGrades);

// 📈 For "Weekly Attendance Trends" chart (Line)
router.get('/weekly-attendance', protect, getWeeklyAttendance);

// 💰 For "Fees Collection" chart (Bar)
router.get('/fees-collection', protect, getFeesCollectionDashboard);

module.exports = router;
