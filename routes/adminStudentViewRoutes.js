const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { getStudentsGroupedByClass } = require('../controllers/adminStudentViewController');

router.get('/students-by-class', protect, restrictTo('admin'), getStudentsGroupedByClass);

module.exports = router;
