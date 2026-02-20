// routes/feedingFeeRoutes.js
const express = require('express');
const router = express.Router();
const {
  markFeeding,
  calculateFeedingFeeCollection,
  getFeedingFeeConfig,
  setFeedingFeeConfig,
  getFeedingFeeForStudent,
  getFeedingFeeSummary,
  getClassesWithFeeBands,
  getAbsenteesForWeek,
  getDebtorsForWeek,
  getDailyTotalSummary
} = require('../controllers/feedingFeeController');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');

// ----------------- Configuration Routes -----------------
router.get('/config', protect, requirePrivateSchool, getFeedingFeeConfig);
router.post('/config', protect, requirePrivateSchool, setFeedingFeeConfig);

// ----------------- Utility & Helper Routes -----------------
router.get('/classes-with-bands', protect, requirePrivateSchool, getClassesWithFeeBands);
router.get('/absentees', protect, requirePrivateSchool, getAbsenteesForWeek);
router.get('/debtors', protect, requirePrivateSchool, getDebtorsForWeek);

// ----------------- Core Fee Collection Routes -----------------
router.post('/calculate', protect, requirePrivateSchool, calculateFeedingFeeCollection);

// ----------------- Student-Focused Routes -----------------
router.get('/student/:studentId', protect, requirePrivateSchool, getFeedingFeeForStudent);

// ----------------- Reporting Routes -----------------
router.get('/summary', protect, requirePrivateSchool, getFeedingFeeSummary);
router.get('/daily-summary', protect, requirePrivateSchool, getDailyTotalSummary);

// ----------------- Manual Marking Routes -----------------
router.post("/mark", protect, requirePrivateSchool, markFeeding);

module.exports = router;