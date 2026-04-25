const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const studentController = require('../controllers/studentController');

const {
  createStudent,
  getAllStudents,
  updateStudent,
  deleteStudent,
  assignStudentToClass,
  getStudentsByClassId,
  getStudentByUserId,
  getStudentById, // ✅ newly added import
  bulkCreateStudents,
  deleteStudentsByClass
} = studentController;

// 🧭 Admin-only: Admit student
router.post('/', protect, restrictTo('admin'), createStudent);
router.post('/bulk', protect, restrictTo('admin'), bulkCreateStudents);

// 🧭 Admin-only: View, update, delete students
router.get('/', protect, restrictTo('admin'), getAllStudents);
router.put('/:id', protect, restrictTo('admin'), updateStudent);
router.delete('/:id', protect, restrictTo('admin'), deleteStudent);
router.delete('/class/:classId', protect, restrictTo('admin'), deleteStudentsByClass);

// 🧭 Admin or Teacher: Assign student to class
router.post('/assign/:id', protect, restrictTo('admin', 'teacher'), assignStudentToClass);

// 🧭 Shared routes
router.get('/class/:classId', protect, getStudentsByClassId);
router.get('/user/:userId', protect, getStudentByUserId);

// 🧭 NEW: Fetch a student by studentId (for parent dashboard & attendance)
router.get('/:id', protect, getStudentById);

module.exports = router;
