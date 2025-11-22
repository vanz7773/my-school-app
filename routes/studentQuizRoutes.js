// routes/studentQuizRoutes.js
const express = require('express');
const {
  getQuiz,
  getQuizzesForClass,
  submitQuiz,
  getProtectedQuiz,
  submitProtectedAttempt,
  getQuizResults
} = require('../controllers/studentQuizController.js'); 

const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// 🔹 Get all quizzes for a class (students see without answers)
router.get('/class/:classId', protect, restrictTo('student'), getQuizzesForClass);

// 🔹 Get a specific quiz (student-safe version, no teacher answers)
router.get('/:quizId', protect, restrictTo('student'), getQuiz);

// 🔹 Submit a quiz attempt
router.post('/:quizId/submit', protect, restrictTo('student'), submitQuiz);

// 🔹 Get protected quiz (anti-copying version)
router.get('/:quizId/protected', protect, restrictTo('student'), getProtectedQuiz);

// 🔹 Submit protected quiz attempt
router.post('/submit-protected', protect, restrictTo('student'), submitProtectedAttempt);

// 🔹 View quiz results (student sees only their own results)
router.get('/:quizId/results', protect, restrictTo('student'), getQuizResults);

module.exports = router;
