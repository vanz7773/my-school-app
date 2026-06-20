const express = require('express');
const router = express.Router();
const allcontrollers = require('../controllers/allControllers');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');
const { checkPermissionForAdmin } = require('../middlewares/permissionMiddleware');

// ----------------- School Admin Routes -----------------
router.post('/fee-templates', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.createFeeTemplate);
router.post('/bills/generate', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.generateBills);
router.post('/bills/preview', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.previewBills);
router.post('/payments', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.recordPayment);
router.delete('/payments/:paymentId/bill/:billId', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.reversePayment);
router.put('/bills/update-or-create', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.updateOrCreateBill);
router.get('/fee-templates', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getFeeTemplates);
router.get('/term-bills', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getTermBills);
router.get('/school-wide-summary', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getSchoolWideTermBillingSummary);
router.get('/audit-report', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getTermBillingAuditReport);
router.post('/bills/exempt/:studentId', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.toggleTermFeeExemption);
router.post('/bills/billing-mode/:studentId', protect, checkPermissionForAdmin('canEditFees'), requirePrivateSchool, allcontrollers.setTermFeeBillingMode);

// ----------------- Parent Portal Routes -----------------
router.get('/parent/bills', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getParentBills);
router.get('/receipts/:paymentId', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.generateReceipt);

// ----------------- Student Portal Routes -----------------
router.get('/student/fees/:studentId', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getStudentBills);
router.get('/student/receipts/:paymentId', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.generateStudentReceipt);
// In your routes file

router.get('/fees/student/receipt-data/:paymentId', protect, checkPermissionForAdmin('canViewFees'), requirePrivateSchool, allcontrollers.getReceiptData);

module.exports = router;
