const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  getClassEnrollmentSummary,
  moveStudentToClass,
} = require('../controllers/enrollmentController');

router.get('/graduates', protect, restrictTo('admin'), require('../controllers/graduatedStudentsController').getGraduatedStudents);

router.get('/summary', protect, restrictTo('admin'), getClassEnrollmentSummary);
router.patch('/students/:studentId/class', protect, restrictTo('admin'), moveStudentToClass);

module.exports = router;
