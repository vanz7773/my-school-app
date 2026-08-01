const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(restrictTo('admin', 'superadmin'));

router.get('/settings', smsController.getSettings);
router.put('/settings', smsController.updateSettings);
router.get('/balance', smsController.getBalance);
router.get('/logs', smsController.getLogs);
router.get('/non-teaching-staff', smsController.getNonTeachingStaff);
router.post('/non-teaching-staff', smsController.createNonTeachingStaff);
router.put('/non-teaching-staff/:id', smsController.updateNonTeachingStaff);
router.delete('/non-teaching-staff/:id', smsController.deleteNonTeachingStaff);
router.post('/send', smsController.sendSingleSms);
router.post('/bulk', smsController.sendBulkSms);
router.post('/trigger-overdue', smsController.triggerOverdueFeesSms);
router.post('/trigger-weekly-daily-fees', smsController.triggerWeeklyDailyFeesSms);

module.exports = router;
