const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const { requireAuth, checkRole } = require('../middlewares/authMiddleware');

router.use(requireAuth);

// Teacher portal
router.get('/my-payslips', checkRole(['teacher']), payrollController.getMyPayslips);

// Admin routes
router.use(checkRole(['admin', 'superadmin']));
router.get('/settings', payrollController.getSettings);
router.post('/settings', payrollController.updateSettings);

router.get('/salaries', payrollController.getTeacherSalaries);
router.post('/salaries', payrollController.updateTeacherSalary);

router.get('/history', payrollController.getPayrollHistory);
router.post('/generate', payrollController.generatePayroll);
router.get('/:id', payrollController.getPayrollDetails);
router.put('/:id/status', payrollController.updatePayrollStatus);

module.exports = router;
