const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  createClass,
  getAllClasses,
  deleteClass,
  assignClassTeacher,
  getTeacherClassesWithStudents,
  getTeacherClasses // new endpoint
} = require('../controllers/classController');

// ---------------- Admin Routes ----------------
router.post('/', protect, restrictTo('admin'), createClass);
router.get('/', protect, restrictTo('admin'), getAllClasses);
router.delete('/:id', protect, restrictTo('admin'), deleteClass);

// Assign/change class teacher (admin only)
router.post('/:classId/assign-class-teacher', protect, restrictTo('admin'), assignClassTeacher);

// ---------------- Teacher Routes ----------------
// For assignments/homework: only return class _id and name
router.get('/teacher/:teacherId/classes', protect, restrictTo('teacher'), getTeacherClasses);



module.exports = router;
