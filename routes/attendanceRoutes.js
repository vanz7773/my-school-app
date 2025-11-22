// routes/attendanceRoutes.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/studentAttendanceController');

router.post('/attendance/initialize-week', attendanceController.initializeWeek);
router.get('/attendance', attendanceController.getWeeklyAttendance);
router.patch('/attendance/:id', attendanceController.markAttendance);

module.exports = router;
