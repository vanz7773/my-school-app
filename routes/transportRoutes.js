const express = require('require');
const router = express.Router();
const transportController = require('../controllers/transportController');
const { protect } = require('../middleware/authMiddleware'); // assuming standard auth middleware

router.use(protect);

// Routes
router.post('/routes', transportController.createRoute);
router.get('/routes', transportController.getRoutes);
router.delete('/routes/:id', transportController.deleteRoute);

// Enrollments
router.post('/enrollments', transportController.enrollStudent);
router.get('/enrollments', transportController.getEnrollments);

// Assignments
router.post('/assignments', transportController.assignTeacher);
router.get('/assignments', transportController.getAssignments);

// Mobile Teacher API
router.get('/teacher/today-assignment', transportController.getTodayAssignment);
router.get('/teacher/route-students', transportController.getRouteStudents);
router.post('/teacher/mark-transport', transportController.syncAttendance);

// Analytics
router.get('/missing-dropoffs', transportController.getMissingDropOffs);
router.get('/daily-attendance', transportController.getDailyAttendance);

// Fees
router.get('/fees', transportController.getFees);
router.post('/fees/pay', transportController.recordPayment);

module.exports = router;
