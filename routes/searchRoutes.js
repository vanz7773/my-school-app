const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const { protect } = require('../middlewares/authMiddleware');

router.get('/', protect, searchController.globalSearch);

module.exports = router;
