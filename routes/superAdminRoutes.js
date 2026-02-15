const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

// 🛡️ Security: All routes require superadmin access
router.use(protect);
router.use(restrictTo('superadmin'));

// 🏫 School Management
router.get('/schools', superAdminController.getAllSchools);
router.put('/schools/:id/status', superAdminController.updateSchoolStatus);

module.exports = router;
