const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/upload');
const studentController = require('../controllers/studentController');
const { downloadStudentContacts, previewStudentContacts, applyStudentContacts } = require('../controllers/studentContactController');
const multer = require('multer');
const contactUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname)),
}).single('file');

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
router.get('/contacts/export', protect, restrictTo('admin'), downloadStudentContacts);
router.post('/contacts/preview', protect, restrictTo('admin'), (req, res, next) => {
  contactUpload(req, res, error => {
    if (error) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'The Excel file must be 5 MB or smaller.' : 'Unable to upload the Excel file.' });
    return next();
  });
}, previewStudentContacts);
router.post('/contacts/apply', protect, restrictTo('admin'), applyStudentContacts);
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
