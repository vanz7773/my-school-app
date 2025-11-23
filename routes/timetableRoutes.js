const express = require('express'); 
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  createTimetableEntry,
  getFilteredTimetable,
  getTeacherTimetable,
  getStudentTimetable,
  getParentTimetables,
  createClassTeacherTimetable,
  updateTimetableEntry,
  deleteTimetableEntry,
  getTeacherClassTimetable

} = require('../controllers/timetableController');

// ✅ Admin: Create timetable entry
router.post('/', protect, restrictTo('admin'), createTimetableEntry);

// ✅ Admin: Filter timetable by class, teacher, day
router.get('/admin', protect, restrictTo('admin'), getFilteredTimetable);

// ✅ Teacher: View own timetable
router.get('/teacher', protect, restrictTo('teacher'), getTeacherTimetable);

// ✅ Student/Parent: View student’s class timetable
router.get('/my-class', protect, restrictTo('student', 'parent'), getStudentTimetable);

router.get("/timetable/teacher/class",protect, restrictTo('teacher'), getTeacherClassTimetable);

// ✅ Parent: View all children’s timetables
router.get('/parent', protect, restrictTo('parent'), getParentTimetables);

// ✅ Class Teacher: Create timetable for their own class
router.post('/class-teacher', protect, restrictTo('teacher'), createClassTeacherTimetable);

// ✅ Update timetable entry (Admin or Teacher with rights + clash prevention)
router.put('/:id', protect, restrictTo('admin', 'teacher'), updateTimetableEntry);

// ✅ Delete timetable entry (Admin or Teacher with rights)
router.delete('/:id', protect, restrictTo('admin', 'teacher'), deleteTimetableEntry);

module.exports = router;
