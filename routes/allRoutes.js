const express = require('express');
const router = express.Router();
const allcontrollers = require('../controllers/allControllers');
const { protect } = require('../middlewares/authMiddleware');

// ----------------- School Admin Routes -----------------
router.post('/fee-templates', protect, allcontrollers.createFeeTemplate);
router.post('/bills/generate', protect, allcontrollers.generateBills);
router.post('/bills/preview', protect, allcontrollers.previewBills);
router.post('/payments', protect, allcontrollers.recordPayment);
router.put('/bills/update-or-create', protect, allcontrollers.updateOrCreateBill);
router.get('/fee-templates', protect, allcontrollers.getFeeTemplates);
router.get('/term-bills', protect, allcontrollers.getTermBills);

// ----------------- Parent Portal Routes -----------------
router.get('/parent/bills', protect, allcontrollers.getParentBills);
router.get('/receipts/:paymentId', protect, allcontrollers.generateReceipt);

// ----------------- Student Portal Routes -----------------
router.get('/student/fees/:studentId', protect, allcontrollers.getStudentBills);
router.get('/student/receipts/:paymentId', protect, allcontrollers.generateStudentReceipt);
// In your routes file

router.get('/fees/student/receipt-data/:paymentId', protect, allcontrollers.getReceiptData);

module.exports = router;
