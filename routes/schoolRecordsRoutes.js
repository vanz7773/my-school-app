const express = require('express');
const router = express.Router();
const { protect, requireGovernmentSchool } = require('../middlewares/authMiddleware');
const { getRecords, updateRecord } = require('../controllers/schoolRecordsController');

// All routes are protected and restricted to Government/Basic schools
router.use(protect);
router.use(requireGovernmentSchool);

router.get('/', getRecords);
router.post('/update', updateRecord);

module.exports = router;
