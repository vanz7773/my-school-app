const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  createTeacher,
  getAllTeachers,
  getTeacherById,
  updateTeacher,
  deleteTeacher,
  getMyStudents,
  getTeacherByUser,
  getTeacherClasses
} = require('../controllers/teacherController');

// Admin creates teacher
router.post('/', protect, restrictTo('admin'), createTeacher);

// Admin views all teachers
router.get('/', protect, restrictTo('admin'), getAllTeachers);

// Admin views or edits a single teacher
router.get('/:id', protect, restrictTo('admin'), getTeacherById);
router.put('/:id', protect, restrictTo('admin'), updateTeacher);
router.delete('/:id', protect, restrictTo('admin'), deleteTeacher);

// Teacher document by user ID (any teacher can fetch their own)
router.get('/by-user/:userId', protect, restrictTo('teacher'), getTeacherByUser);
// Get all classes assigned to a teacher by teacherId
router.get('/:teacherId/classes', protect, restrictTo('teacher', 'admin'), getTeacherClasses);





// Teacher views their students
router.get('/me/students', protect, restrictTo('teacher'), getMyStudents);

module.exports = router;
