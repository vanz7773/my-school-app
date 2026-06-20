// routes/feedingFeeRoutes.js
const express = require('express');
const router = express.Router();
const {
  markFeeding,
  markFeedingBulk,
  calculateFeedingFeeCollection,
  getFeedingFeeConfig,
  setFeedingFeeConfig,
  getFeedingFeeForStudent,
  getFeedingFeeSummary,
  getClassesWithFeeBands,
  getAbsenteesForWeek,
  getDebtorsForWeek,
  getDailyTotalSummary,
  getFeedingFeeAuditReport,
  setStudentCustomFeedingFee
} = require('../controllers/feedingFeeController');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');
const { checkPermissionForAdmin } = require('../middlewares/permissionMiddleware');

// ----------------- Configuration Routes -----------------
router.get('/config', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getFeedingFeeConfig);
router.post('/config', protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, setFeedingFeeConfig);

// ----------------- Utility & Helper Routes -----------------
router.get('/classes-with-bands', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getClassesWithFeeBands);
router.get('/absentees', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getAbsenteesForWeek);
router.get('/debtors', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getDebtorsForWeek);

// ----------------- Core Fee Collection Routes -----------------
router.post('/calculate', protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, calculateFeedingFeeCollection);

// ----------------- Student-Focused Routes -----------------
router.get('/student/:studentId', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getFeedingFeeForStudent);

// ----------------- Reporting Routes -----------------
router.get('/summary', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getFeedingFeeSummary);
router.get('/daily-summary', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getDailyTotalSummary);
router.get('/audit-report', protect, checkPermissionForAdmin('canViewFeedingFee'), requirePrivateSchool, getFeedingFeeAuditReport);

// ----------------- Manual Marking Routes -----------------
router.post("/mark", protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, markFeeding);
router.post("/mark-bulk", protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, markFeedingBulk);
router.post("/student/:studentId/custom-fee", protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, setStudentCustomFeedingFee);
router.post("/exempt/:studentId", protect, checkPermissionForAdmin('canEditFeedingFee'), requirePrivateSchool, require('../controllers/feedingFeeController').toggleFeedingFeeExemption);

module.exports = router;
