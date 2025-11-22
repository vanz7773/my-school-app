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
  getClassesWithFeeBands
} = require('../controllers/feedingFeeController');
const { protect } = require('../middlewares/authMiddleware');

// ----------------- Configuration Routes -----------------
router.get('/config', protect, getFeedingFeeConfig);
router.post('/config', protect, setFeedingFeeConfig);

// ----------------- Utility & Helper Routes -----------------
router.get('/classes-with-bands', protect, getClassesWithFeeBands);

// ----------------- Core Fee Collection Routes -----------------
router.post('/calculate', protect, calculateFeedingFeeCollection);

// ----------------- Student-Focused Routes -----------------
router.get('/student/:studentId', protect, getFeedingFeeForStudent);

// ----------------- Reporting Routes -----------------
router.get('/summary', protect, getFeedingFeeSummary);

// ----------------- Manual Marking Routes -----------------
router.post("/mark", protect, markFeeding);

module.exports = router;