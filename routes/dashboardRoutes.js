const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { checkPermission } = require('../middlewares/permissionMiddleware');
const {
  getDashboard,
  getStudentsByClass,
  getAverageGrades,
  getWeeklyAttendance,
  getFeesCollectionDashboard
} = require('../controllers/dashboardController');

// 👤 Dashboard summary based on user role
router.get('/', protect, checkPermission('canViewDashboard'), getDashboard);

// 📊 For "Students per Class" chart (Pie)
router.get('/students-by-class', protect, checkPermission('canViewDashboard'), getStudentsByClass);

// 📊 For "Average Grades per Class" chart (Bar)
router.get('/average-grades', protect, checkPermission('canViewDashboard'), getAverageGrades);

// 📈 For "Weekly Attendance Trends" chart (Line)
router.get('/weekly-attendance', protect, checkPermission('canViewDashboard'), getWeeklyAttendance);

// 💰 For "Fees Collection" chart (Bar)
router.get('/fees-collection', protect, checkPermission('canViewDashboard'), getFeesCollectionDashboard);

module.exports = router;
