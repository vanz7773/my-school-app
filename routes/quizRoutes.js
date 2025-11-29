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
  autoSubmitQuiz
} = require('../controllers/quizController.js');

const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// -------------------------------------------------------------
// TEACHER ROUTES
// -------------------------------------------------------------

// Teacher creates quiz manually
router.post('/create', protect, restrictTo('teacher'), createQuiz);

// All quizzes for a school (teacher only)
router.get('/school/:schoolId', protect, restrictTo('teacher'), getQuizzesForSchool);

// All quizzes for a class
router.get('/class/:classId', protect, getQuizzesForClass);

// Average scores for radar chart
router.get('/data/radar-chart', protect, restrictTo('admin'), getAverageScoresPerSubject);

// Update quiz
router.put('/:quizId', protect, restrictTo('teacher'), updateQuiz);

// Publish/Unpublish quiz
router.patch('/:quizId/publish', protect, restrictTo('teacher'), publishQuiz);

// Delete quiz
router.delete('/:quizId', protect, restrictTo('teacher'), deleteQuiz);

// Protected quiz view (anti-copy)
router.get('/:quizId/protected', protect, getProtectedQuiz);

// Get all quiz results across teacher's classes
router.get(
  "/teacher/class-results",
  protect,
  restrictTo("teacher"),
  getAllClassQuizResultsForTeacher
);

// Grade a question manually
router.put(
  "/results/:resultId/grade-question",
  protect,
  restrictTo("teacher"),
  gradeQuestion
);

// -------------------------------------------------------------
// STUDENT ROUTES — ORDER MATTERS HERE! (IMPORTANT)
// -------------------------------------------------------------

// Check completion
router.get('/:quizId/completion', protect, restrictTo('student'), checkQuizCompletion);

// Check active progress
router.get('/:quizId/progress', protect, restrictTo('student'), checkQuizInProgress);

// Start a new quiz attempt
router.post('/:quizId/start', protect, restrictTo('student'), startQuizAttempt);

// Resume in-progress attempt
router.get('/:quizId/resume', protect, restrictTo('student'), resumeQuizAttempt);

// Save progress
router.post('/:quizId/save', protect, restrictTo('student'), saveQuizProgress);

// Student submits quiz
router.post('/:quizId/submit', protect, restrictTo('student'), submitQuiz);

// Auto-submit quiz (timer expired)
router.post('/:quizId/auto-submit', protect, restrictTo('student'), autoSubmitQuiz);

// Student views their own results
router.get('/results/student/:studentId', protect, restrictTo('student', 'parent', 'teacher'), getResultsForStudent);

// Get a specific quiz result object
router.get("/results/:resultId", protect, restrictTo("student", "parent", "teacher"), getQuizResultById);

// Teacher/Student view results for quiz
router.get('/:quizId/results', protect, restrictTo('teacher','student'), getQuizResults);

// -------------------------------------------------------------
// 🔥 MUST BE LAST — GET QUIZ BY ID
// -------------------------------------------------------------
router.get('/:quizId', protect, getQuiz);

module.exports = router;
