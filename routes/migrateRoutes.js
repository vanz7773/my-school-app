const express = require('express');
const router = express.Router();
const migrateController = require('../controllers/migrateController');
const { protect } = require('../middlewares/authMiddleware');

// POST /api/migrate
router.post('/', protect, migrateController.migrateStudents);

module.exports = router;
