const express = require('express');
const router = express.Router();
const schoolRecordsController = require('../controllers/schoolRecordsController');
const { protect, authorize } = require('../middlewares/authMiddleware');

// Route to get all records for the school
router.get('/', protect, authorize('admin'), schoolRecordsController.getSchoolRecords);

// Route to update (or create) a record for a specific class
router.put('/', protect, authorize('admin'), schoolRecordsController.updateSchoolRecord);

module.exports = router;
