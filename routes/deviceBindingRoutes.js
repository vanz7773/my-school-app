// routes/deviceBindingRoutes.js
const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { rebindDevice } = require('../controllers/deviceBindingController');

// Only admins/supervisors can rebind devices
router.post('/rebind', protect, restrictTo('admin'), rebindDevice);

module.exports = router;
