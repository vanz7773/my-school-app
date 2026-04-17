const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { addOrUpdateExercise, updateExercise, getExerciseSummary, finalizeWeek, getExercisesForStudent } = require('../controllers/weeklyExerciseController');

// Teacher adds or updates exercise count
router.post('/', protect, restrictTo('admin', 'teacher'), addOrUpdateExercise);
router.patch('/:exerciseId', protect, restrictTo('teacher'), updateExercise);
router.post('/finalize', protect, restrictTo('teacher'), finalizeWeek);

// Admin/Teacher views summary
router.get('/summary', protect, restrictTo('admin', 'teacher'), getExerciseSummary);

module.exports = router;
