const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/upload');
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
  bulkUploadPictures, // ✅ bulk pictures import
  deleteStudentsByClass
} = studentController;

// 🧭 Admin-only: Admit student
router.post('/', protect, restrictTo('admin'), upload.single('profilePicture'), createStudent);
router.post('/bulk', protect, restrictTo('admin'), bulkCreateStudents);
router.post('/bulk-pictures', protect, restrictTo('admin'), upload.array('pictures', 100), bulkUploadPictures);

// 🧭 Admin-only: View, update, delete students
router.get('/', protect, restrictTo('admin'), getAllStudents);
router.put('/:id', protect, restrictTo('admin'), upload.single('profilePicture'), updateStudent);
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
