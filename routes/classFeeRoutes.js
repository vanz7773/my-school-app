const express = require('express');
const router = express.Router();
const {
  calculateClassFeeCollection,
  getClassFeeConfig,
  getClassFeeSummary,
  markClassFeeBulk,
  setClassFeeConfig,
} = require('../controllers/classFeeController');
const { protect, requirePrivateSchool } = require('../middlewares/authMiddleware');
const { checkPermissionForAdmin } = require('../middlewares/permissionMiddleware');

router.get(
  '/config',
  protect,
  checkPermissionForAdmin('canViewFees'),
  requirePrivateSchool,
  getClassFeeConfig
);

router.post(
  '/config',
  protect,
  checkPermissionForAdmin('canEditFees'),
  requirePrivateSchool,
  setClassFeeConfig
);

router.post(
  '/calculate',
  protect,
  checkPermissionForAdmin('canViewFees'),
  requirePrivateSchool,
  calculateClassFeeCollection
);

router.get(
  '/summary',
  protect,
  checkPermissionForAdmin('canViewFees'),
  requirePrivateSchool,
  getClassFeeSummary
);

router.post(
  '/mark-bulk',
  protect,
  checkPermissionForAdmin('canEditFees'),
  requirePrivateSchool,
  markClassFeeBulk
);

module.exports = router;
