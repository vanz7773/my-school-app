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
router.put('/schools/:id/features', superAdminController.updateSchoolFeatures);
router.post('/schools/:id/alert-owing', superAdminController.alertOwingSchool);
router.post('/schools/:id/credit-sms', superAdminController.creditSmsBalance);
router.post('/schools/:id/send-sms', superAdminController.sendSmsToAdmin);
router.get('/schools/:id/sms-logs', superAdminController.getSchoolSmsLogs);

// 📍 Geofence overrides/Clock-in Exceptions
router.get('/schools/:id/teachers', superAdminController.getSchoolTeachersAndExceptions);
router.post('/teachers/:teacherId/exception', superAdminController.updateTeacherException);



// 💰 School Transactions (Invoices & Payments)
router.get('/schools/:schoolId/transactions', superAdminController.getSchoolTransactions);
router.post('/schools/:schoolId/transactions', superAdminController.createSchoolTransaction);
router.put('/transactions/:id/status', superAdminController.updateTransactionStatus);

module.exports = router;
