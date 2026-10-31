const express = require('express');
const router = express.Router();
const upload = require('../utils/upload'); // the memory-storage version
const { saveSchoolInfo, getSchoolInfo, getFileById, getMyTransactions, getSubscriptionStatus } = require('../controllers/schoolInfocontroller');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/my-transactions', protect, getMyTransactions);

router.get('/subscription-status', protect, restrictTo('admin'), getSubscriptionStatus);
router.post('/subscription-payments/:paymentId/acknowledge', protect, restrictTo('admin'), require('../controllers/subscriptionPaymentConfirmationController').acknowledgePaymentConfirmation);

router.get('/', protect, getSchoolInfo);

router.post(
  '/',
  protect,
  upload,  // use directly, do NOT call .fields() here
  saveSchoolInfo
);

router.get('/files/:id', protect, getFileById);

module.exports = router;
