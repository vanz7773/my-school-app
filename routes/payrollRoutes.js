const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.use(protect);

// Teacher portal
router.get('/my-payslips', restrictTo('teacher'), payrollController.getMyPayslips);

// Shared route for downloading PDF (authorization logic inside controller)
router.get('/:id/download-pdf', payrollController.downloadPdf);

// Admin routes
router.use(restrictTo('admin', 'superadmin'));
router.get('/settings', payrollController.getSettings);
router.post('/settings', payrollController.updateSettings);

router.get('/salaries', payrollController.getTeacherSalaries);
router.post('/salaries', payrollController.updateTeacherSalary);

router.get('/history', payrollController.getPayrollHistory);
router.post('/generate', payrollController.generatePayroll);
router.get('/:id', payrollController.getPayrollDetails);
router.put('/:id/status', payrollController.updatePayrollStatus);

module.exports = router;
