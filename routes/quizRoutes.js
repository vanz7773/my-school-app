const express = require('express');
const {
  createQuiz,
  getQuiz,
  getQuizzesForClass,
  getQuizResults,
  getAverageScoresPerSubject,
  getQuizzesForSchool,
  updateQuiz,
  deleteQuiz,
  getProtectedQuiz,
  publishQuiz,
  submitQuiz,
  getResultsForStudent,
  getQuizResultById,
  getAllClassQuizResultsForTeacher,
  checkQuizCompletion,
  checkQuizInProgress,
  startQuizAttempt,
  resumeQuizAttempt,
  saveQuizProgress,
  gradeQuestion,
  getActiveAttempt,
  startOrResumeAttempt,
  saveAttemptProgress,
  validateActiveAttempt,

} = require('../controllers/quizController.js');

const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// -------------------------------------------------------------
// TEACHER ROUTES
// -------------------------------------------------------------

router.post('/create', protect, restrictTo('teacher'), createQuiz);
router.get('/school/:schoolId', protect, restrictTo('teacher'), getQuizzesForSchool);
router.get('/class/:classId', protect, getQuizzesForClass);
router.get('/data/radar-chart', protect, restrictTo('admin'), getAverageScoresPerSubject);

router.put('/:quizId', protect, restrictTo('teacher'), updateQuiz);
router.patch('/:quizId/publish', protect, restrictTo('teacher'), publishQuiz);
router.delete('/:quizId', protect, restrictTo('teacher'), deleteQuiz);

router.get('/:quizId/protected', protect, getProtectedQuiz);

router.get(
  "/teacher/class-results",
  protect,
  restrictTo("teacher"),
  getAllClassQuizResultsForTeacher
);

router.put(
  "/results/:resultId/grade-question",
  protect,
  restrictTo("teacher"),
  gradeQuestion
);

// -------------------------------------------------------------
// STUDENT ROUTES — ORDER IS EXTREMELY IMPORTANT
// -------------------------------------------------------------

router.get('/:quizId/completion', protect, restrictTo('student'), checkQuizCompletion);
router.get('/:quizId/progress', protect, restrictTo('student'), checkQuizInProgress);
router.post('/:quizId/start', protect, restrictTo('student'), startQuizAttempt);
router.get('/:quizId/resume', protect, restrictTo('student'), resumeQuizAttempt);
router.post('/:quizId/save', protect, restrictTo('student'), saveQuizProgress);

// 🔥 Submit must come BEFORE any /results/ routes
router.post('/:quizId/submit', protect, restrictTo('student'), submitQuiz);

// Check for active attempt (for frontend to show Resume/Start)
router.get('/:quizId/attempt/active', protect, restrictTo('student'), getActiveAttempt);

// Start or resume attempt (atomic operation)
router.post('/:quizId/attempt/start', protect, restrictTo('student'), startOrResumeAttempt);

// Save progress (with atomic update)
router.post('/:quizId/attempt/save', protect, restrictTo('student'), saveAttemptProgress);

// Get attempt details (for resuming)
router.get('/:quizId/attempt', protect, restrictTo('student'), validateActiveAttempt, (req, res) => {
  res.json({
    success: true,
    attempt: req.attempt,
    timeRemaining: Math.floor((req.attempt.expiresAt - new Date()) / 1000),
  });
});

// Student reads their own results
router.get('/results/student/:studentId', protect, restrictTo('student', 'parent', 'teacher'), getResultsForStudent);

// Single quiz result record
router.get("/results/:resultId", protect, restrictTo("student", "parent", "teacher"), getQuizResultById);

// Results for a quiz
router.get('/:quizId/results', protect, restrictTo('teacher','student'), getQuizResults);

// -------------------------------------------------------------
// MUST BE LAST — GET QUIZ BY ID
// -------------------------------------------------------------
router.get('/:quizId', protect, getQuiz);

module.exports = router;
