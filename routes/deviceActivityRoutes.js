const express = require('express');
const router = express.Router();
const deviceActivityController = require('../controllers/deviceActivityController');
const { protect, restrictTo } = require('../middlewares/authMiddleware'); // Existing typical auth

// Endpoint for mobile devices to POST sync logs
router.post('/sync', protect, deviceActivityController.syncLogs);

// Endpoint for admin dashboard to view generated alerts
router.get('/alerts', protect, restrictTo('superadmin', 'admin', 'principal'), deviceActivityController.getAlerts);

// Endpoint for admin dashboard overview cards and table
router.get('/overview', protect, restrictTo('superadmin', 'admin', 'principal'), deviceActivityController.getOverview);

// Endpoint for detailed timeline logs of a specific teacher
router.get('/teacher/:id', protect, restrictTo('superadmin', 'admin', 'principal'), deviceActivityController.getTeacherLogs);

// Endpoint to mark a specific alert as processed/reviewed
router.patch('/alerts/:id/review', protect, restrictTo('superadmin', 'admin', 'principal'), deviceActivityController.reviewAlert);

module.exports = router;
