const express = require('express');
const router = express.Router();
const transportController = require('../controllers/transportController');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');

router.use(protect);
// 🛑 Lock all Transport API endpoints to Private Schools strictly
router.use(requirePrivateSchool);

// Buses
router.post('/buses', transportController.createBus);
router.get('/buses', transportController.getBuses);
router.put('/buses/:id', transportController.updateBus);
router.delete('/buses/:id', transportController.deleteBus);

// Routes
router.post('/routes', transportController.createRoute);
router.get('/routes', transportController.getRoutes);
router.delete('/routes/:id', transportController.deleteRoute);

// Enrollments
router.post('/enrollments', transportController.enrollStudent);
router.get('/enrollments', transportController.getEnrollments);
router.put('/enrollments/:enrollmentId/fee', transportController.updateEnrollmentFee);

// Assignments
router.post('/assignments', transportController.assignTeacher);
router.get('/assignments', transportController.getAssignments);

// Mobile Teacher API
router.get('/teacher/today-assignment', transportController.getTodayAssignment);
router.get('/teacher/route-students', transportController.getRouteStudents);
router.post('/teacher/mark-transport', transportController.syncAttendance);

// Analytics & Reports
router.get('/missing-dropoffs', transportController.getMissingDropOffs);
router.get('/daily-attendance', transportController.getDailyAttendance);
router.get('/monthly-report', transportController.getMonthlyReport);

// Fees (Legacy or Optional)
router.get('/fees', transportController.getFees);
router.post('/fees/pay', transportController.recordPayment);

// Weekly Fee Payment (Teacher records when student pays for whole week)
router.post('/teacher/weekly-fee-payment', transportController.recordWeeklyFeePayment);
router.get('/teacher/weekly-fee-payments', transportController.getWeeklyFeePayments);

module.exports = router;
