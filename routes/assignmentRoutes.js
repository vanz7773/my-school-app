const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const {
  createAssignment,
  getAssignmentsForTeacher,
  getAssignmentsForClass,
  updateAssignment,
  deleteAssignment,
  getAssignmentsForStudent,
  getAllAssignmentsForAdmin   // ← NEW
} = require('../controllers/assignmentController');

// ✅ NEW: Admin gets ALL assignments (no route changed)
router.get('/admin/all', protect, restrictTo('admin'), getAllAssignmentsForAdmin);

// ✅ Teachers/Admins create assignment
router.post('/', protect, restrictTo('teacher', 'admin'), createAssignment);

// ✅ Teachers/Admins get assignments for their classes (or all for admin)
router.get('/', protect, restrictTo('teacher', 'admin'), getAssignmentsForTeacher);

router.get('/my', protect, restrictTo('student', 'parent'), getAssignmentsForStudent);

// ✅ Students get assignments for their class
router.get('/:classId', protect, restrictTo('student', 'teacher', 'admin', 'parent'), getAssignmentsForClass);

// 👍 Update assignment
router.put('/:id', protect, restrictTo('teacher', 'admin'), updateAssignment);

// 👍 Delete assignment
router.delete('/:id', protect, restrictTo('teacher', 'admin'), deleteAssignment);

module.exports = router;
