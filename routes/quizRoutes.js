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

// Teacher creates quiz manually (no AI generation)
router.post('/create', protect, restrictTo('teacher'), createQuiz);

// Get a specific quiz (different data returned for teachers vs students)
router.get('/:quizId', protect, getQuiz);

// Get all quizzes for a school (teacher only)
router.get('/school/:schoolId', protect, restrictTo('teacher'), getQuizzesForSchool);

// Get all quizzes for a class (students see without answers, teachers see with answers)
router.get('/class/:classId', protect, getQuizzesForClass);

// Student submits quiz attempt
router.post('/:quizId/submit', protect, restrictTo('student'), submitQuiz);

router.post('/:quizId/auto-submit', protect, restrictTo('student'), autoSubmitQuiz);

// Teacher and student views quiz results
router.get('/:quizId/results', protect, restrictTo('teacher','student'), getQuizResults);

// Get average scores per subject for radar chart (teacher only)
router.get('/data/radar-chart', protect, restrictTo('admin'), getAverageScoresPerSubject);

// Update a quiz (teacher only, and only if they created it)
router.put('/:quizId', protect, restrictTo('teacher'), updateQuiz);

// Publish/Unpublish a quiz (teacher only, and only if they created it)
router.patch('/:quizId/publish', protect, restrictTo('teacher'), publishQuiz);

// Delete a quiz (teacher only, and only if they created it)
router.delete('/:quizId', protect, restrictTo('teacher'), deleteQuiz);

// Get protected quiz (anti-copying measures) – open to both roles
router.get('/:quizId/protected', protect, getProtectedQuiz);


// Fetch results for a specific student (student sees only their own results)
router.get('/results/student/:studentId', protect, restrictTo('student', 'parent', 'teacher'), getResultsForStudent);

// Get a specific quiz result by ID
router.get("/results/:resultId", protect, restrictTo("student", "parent", "teacher"), getQuizResultById);

// ✅ Get all quiz results across all teacher's classes (new nested format)
router.get(
  "/teacher/class-results",
  protect,
  restrictTo("teacher"),
  getAllClassQuizResultsForTeacher
);

// 🧾 Grade a single question in a student's result (teacher only)
router.put(
  "/results/:resultId/grade-question", protect, restrictTo("teacher"), gradeQuestion
);

// Check if student has completed a quiz
router.get('/:quizId/completion', protect, restrictTo('student'), checkQuizCompletion);

// Check if student has an in-progress quiz attempt
router.get('/:quizId/progress', protect, restrictTo('student'), checkQuizInProgress);

// Start a new quiz attempt
router.post('/:quizId/start', protect, restrictTo('student'), startQuizAttempt);

// Resume an in-progress quiz attempt
router.get('/:quizId/resume', protect, restrictTo('student'), resumeQuizAttempt);

// Save quiz progress during attempt
router.post('/:quizId/save', protect, restrictTo('student'), saveQuizProgress);


module.exports = router;