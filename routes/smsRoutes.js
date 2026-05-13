const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);
router.use(authorize('admin', 'superadmin'));

router.get('/settings', smsController.getSettings);
router.put('/settings', smsController.updateSettings);
router.get('/balance', smsController.getBalance);
router.get('/logs', smsController.getLogs);
router.post('/send', smsController.sendSingleSms);
router.post('/bulk', smsController.sendBulkSms);
router.post('/trigger-overdue', smsController.triggerOverdueFeesSms);

module.exports = router;
