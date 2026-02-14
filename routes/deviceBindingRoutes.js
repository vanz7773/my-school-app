// routes/deviceBindingRoutes.js
const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { rebindDevice, resetBinding } = require('../controllers/deviceBindingController');

// Only admins/supervisors can rebind devices
router.post('/rebind', protect, restrictTo('admin'), rebindDevice);
router.post('/reset', protect, restrictTo('admin'), resetBinding);

module.exports = router;
