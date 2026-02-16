const express = require('express');
const router = express.Router();
const webPushController = require('../controllers/webPushController');
const { protect } = require('../middlewares/authMiddleware');

// @desc    Subscribe to web push notifications
// @route   POST /api/web-push/subscribe
// @access  Protected
router.post('/subscribe', protect, webPushController.subscribe);

// @desc    Send test notification (Admin only)
// @route   POST /api/web-push/test
// @access  Protected
router.post('/test', protect, (req, res, next) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin')) {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized' });
    }
}, webPushController.sendTestNotification);

module.exports = router;
