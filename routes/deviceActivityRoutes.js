const express = require('express');
const router = express.Router();
const deviceActivityController = require('../controllers/deviceActivityController');
const { protect } = require('../middleware/authMiddleware'); // Existing typical auth
const authorize = require('../middleware/authorize'); // Existing typical role gatekeeper

// Endpoint for mobile devices to POST sync logs
router.post('/sync', protect, deviceActivityController.syncLogs);

// Endpoint for admin dashboard to view generated alerts
router.get('/alerts', protect, authorize('superAdmin', 'admin', 'principal'), deviceActivityController.getAlerts);

// Endpoint for admin dashboard overview cards and table
router.get('/overview', protect, authorize('superAdmin', 'admin', 'principal'), deviceActivityController.getOverview);

// Endpoint for detailed timeline logs of a specific teacher
router.get('/teacher/:id', protect, authorize('superAdmin', 'admin', 'principal'), deviceActivityController.getTeacherLogs);

// Endpoint to mark a specific alert as processed/reviewed
router.patch('/alerts/:id/review', protect, authorize('superAdmin', 'admin', 'principal'), deviceActivityController.reviewAlert);

module.exports = router;
