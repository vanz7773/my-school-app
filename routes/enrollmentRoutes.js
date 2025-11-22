const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { getClassEnrollmentSummary } = require('../controllers/enrollmentController');

router.get('/summary', protect, restrictTo('admin'), getClassEnrollmentSummary);

module.exports = router;
