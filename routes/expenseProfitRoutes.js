const express = require('express');
const router = express.Router();
const {
  createExpense,
  deleteExpense,
  getExpenseProfitSummary,
  updateExpense,
} = require('../controllers/expenseProfitController');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');
const { checkPermissionForAdmin } = require('../middlewares/permissionMiddleware');

router.get(
  '/summary',
  protect,
  checkPermissionForAdmin('canViewFees'),
  requirePrivateSchool,
  getExpenseProfitSummary
);

router.post(
  '/expenses',
  protect,
  checkPermissionForAdmin('canEditFees'),
  requirePrivateSchool,
  createExpense
);

router.put(
  '/expenses/:id',
  protect,
  checkPermissionForAdmin('canEditFees'),
  requirePrivateSchool,
  updateExpense
);

router.delete(
  '/expenses/:id',
  protect,
  checkPermissionForAdmin('canEditFees'),
  requirePrivateSchool,
  deleteExpense
);

module.exports = router;
