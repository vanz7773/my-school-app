const express = require('express');
const router = express.Router();
const allcontrollers = require('../controllers/allControllers');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');

// ----------------- School Admin Routes -----------------
router.post('/fee-templates', protect, requirePrivateSchool, allcontrollers.createFeeTemplate);
router.post('/bills/generate', protect, requirePrivateSchool, allcontrollers.generateBills);
router.post('/bills/preview', protect, requirePrivateSchool, allcontrollers.previewBills);
router.post('/payments', protect, requirePrivateSchool, allcontrollers.recordPayment);
router.put('/bills/update-or-create', protect, requirePrivateSchool, allcontrollers.updateOrCreateBill);
router.get('/fee-templates', protect, requirePrivateSchool, allcontrollers.getFeeTemplates);
router.get('/term-bills', protect, requirePrivateSchool, allcontrollers.getTermBills);

// ----------------- Parent Portal Routes -----------------
router.get('/parent/bills', protect, requirePrivateSchool, allcontrollers.getParentBills);
router.get('/receipts/:paymentId', protect, requirePrivateSchool, allcontrollers.generateReceipt);

// ----------------- Student Portal Routes -----------------
router.get('/student/fees/:studentId', protect, requirePrivateSchool, allcontrollers.getStudentBills);
router.get('/student/receipts/:paymentId', protect, requirePrivateSchool, allcontrollers.generateStudentReceipt);
// In your routes file

router.get('/fees/student/receipt-data/:paymentId', protect, requirePrivateSchool, allcontrollers.getReceiptData);

module.exports = router; ß
