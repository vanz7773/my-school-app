const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  addGrades,
  getReportCard,
  getAllGrades,
  getGradeEntrySetup,
  updateGrade,
  generateReportCardPDF // 👈 use the PDF version
} = require('../controllers/gradeController');

router.post('/add', protect, restrictTo('teacher', 'admin'), addGrades);
router.get('/report-card', protect, restrictTo('teacher', 'admin', 'parent'), getReportCard);
router.get('/all', protect, restrictTo('teacher', 'admin'), getAllGrades);
router.get('/entry-setup', protect, restrictTo('teacher', 'admin'), getGradeEntrySetup);
router.patch('/:gradeId', protect, restrictTo('teacher', 'admin'), updateGrade);

// ✅ Fix: use the correct controller function
router.get('/generate-report-pdf', protect, restrictTo('teacher', 'admin'), generateReportCardPDF);

module.exports = router;
