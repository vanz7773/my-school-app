const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { checkPermission } = require('../middlewares/permissionMiddleware');
const {
  createTeacher,
  bulkCreateTeachers,
  getAllTeachers,
  getTeacherById,
  updateTeacher,
  deleteTeacher,
  getMyStudents,
  getTeacherByUser,
  getTeacherClasses,
  updateMyProfile,
  getMyProfile
} = require('../controllers/teacherController');

// Admin creates teacher
router.post('/', protect, restrictTo('admin'), checkPermission('canAddTeachers'), createTeacher);
router.post('/bulk', protect, restrictTo('admin'), checkPermission('canAddTeachers'), bulkCreateTeachers);

// Teacher-specific routes (must be before :id routes)
router.get('/me', protect, restrictTo('teacher'), getMyProfile);
router.put('/me/profile', protect, restrictTo('teacher'), updateMyProfile);

// Admin views all teachers
router.get('/', protect, restrictTo('admin'), checkPermission('canViewTeachers'), getAllTeachers);

// ✅ SPECIFIC ROUTES FIRST
router.get('/by-user/:userId', protect, restrictTo('teacher'), getTeacherByUser);
router.get('/:teacherId/classes', protect, restrictTo('teacher', 'admin'), getTeacherClasses);

// Teacher views their students
router.get('/me/students', protect, restrictTo('teacher'), getMyStudents);

// ❗ GENERIC :id ROUTES LAST
router.get('/:id', protect, restrictTo('admin'), checkPermission('canViewTeachers'), getTeacherById);
router.put('/:id', protect, restrictTo('admin'), checkPermission('canEditTeachers'), updateTeacher);
router.delete('/:id', protect, restrictTo('admin'), checkPermission('canDeleteTeachers'), deleteTeacher);

module.exports = router;
