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

// 💰 School Transactions (Invoices & Payments)
router.get('/schools/:schoolId/transactions', superAdminController.getSchoolTransactions);
router.post('/schools/:schoolId/transactions', superAdminController.createSchoolTransaction);
router.put('/transactions/:id/status', superAdminController.updateTransactionStatus);

module.exports = router;
