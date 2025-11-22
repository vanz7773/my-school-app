const express = require('express');
const router = express.Router();
const movementController = require('../controllers/movementController');

const { protect } = require('../middlewares/authMiddleware');
// POST movement
router.post('/', protect, movementController.createMovement);

// GET all (optional - admin use)
router.get('/', protect, movementController.getAllMovements);

// GET only teacher's own movements
router.get('/my', protect, movementController.getTeacherMovements);

module.exports = router;
