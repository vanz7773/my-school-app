const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  submitAssignment,
  getSubmissionsByAssignment,
  getStudentSubmissions
} = require('../controllers/submissionController');

// Student submits an assignment
router.post('/', protect, restrictTo('student'), submitAssignment);

// Admin or teacher views all submissions for a given assignment
router.get('/assignment/:id', protect, restrictTo('admin', 'teacher'), getSubmissionsByAssignment);

// Student views their submissions
router.get('/my-submissions', protect, restrictTo('student'), getStudentSubmissions);

module.exports = router;
