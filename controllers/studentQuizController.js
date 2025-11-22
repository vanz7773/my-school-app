const QuizResult = require('../models/QuizResult');
const QuizSession = require('../models/QuizSession');
const Notifications = require('../models/Notifications');
const User = require('../models/User');
const mongoose = require('mongoose');

const toObjectId = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
};

// ---------------------------
// 1. Get Available Quizzes for Student’s Class
// ---------------------------
exports.getMyClassQuizzes = async (req, res) => {
  try {
    const school = toObjectId(req.user.school);
    const student = await User.findById(req.user._id);

    if (!student || !student.class) {
      return res.status(403).json({ message: 'Student is not assigned to a class' });
    }

    const quizzes = await QuizSession.find({
      school,
      class: toObjectId(student.class),
      isPublished: true
    }).select('-questions.correctAnswer -questions.explanation');

    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching quizzes', error: error.message });
  }
};

// ---------------------------
// 2. Get Quiz Details (Student View)
// ---------------------------
exports.getQuizForStudent = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const student = await User.findById(req.user._id);

    const quiz = await QuizSession.findOne({ _id: toObjectId(quizId), school, isPublished: true });

    if (!quiz) return res.status(404).json({ message: 'Quiz not found or not published' });
    if (student.class.toString() !== quiz.class.toString()) {
      return res.status(403).json({ message: 'This quiz is not for your class' });
    }

    // Hide answers
    const sanitizedQuestions = quiz.questions.map(q => ({
      _id: q._id,
      questionText: q.questionText,
      type: q.type,
      options: q.options,
      points: q.points
    }));

    res.json({
      _id: quiz._id,
      title: quiz.title,
      subject: quiz.subject,
      dueDate: quiz.dueDate,
      timeLimit: quiz.timeLimit,
      questions: sanitizedQuestions
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading quiz', error: error.message });
  }
};

// ---------------------------
// 3. Start Quiz Session
// ---------------------------
exports.startQuizSession = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const student = await User.findById(req.user._id);

    const quiz = await QuizSession.findOne({ _id: toObjectId(quizId), school, isPublished: true });
    if (!quiz) return res.status(404).json({ message: 'Quiz not found or not published' });
    if (student.class.toString() !== quiz.class.toString()) {
      return res.status(403).json({ message: 'Not your class quiz' });
    }

    const sessionId = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await QuizSession.create({
      sessionId,
      quizId: quiz._id,
      studentId: student._id,
      expiresAt,
      startTime: new Date()
    });

    res.json({ sessionId, quizTitle: quiz.title, timeLimit: quiz.timeLimit, expiresAt });
  } catch (error) {
    res.status(500).json({ message: 'Error starting quiz session', error: error.message });
  }
};

// ---------------------------
// 4. Submit Attempt
// ---------------------------
exports.submitQuizAttempt = async (req, res) => {
  try {
    const { sessionId, answers, timeSpent } = req.body;
    const studentId = req.user._id;
    const school = toObjectId(req.user.school);

    const session = await QuizSession.findOne({ sessionId, studentId, expiresAt: { $gt: new Date() } });
    if (!session) return res.status(403).json({ message: 'Invalid or expired session' });

    const quiz = await QuizSession.findById(session.quizId);
    if (!quiz) return res.status(404).json({ message: 'Quiz not found' });

    let score = 0, totalPoints = 0;
    const results = quiz.questions.map((q, i) => {
      const selected = answers[i] || null;
      const correct = q.correctAnswer;
      const isCorrect = selected === String(correct);
      if (isCorrect) score += q.points || 1;
      totalPoints += q.points || 1;

      return {
        question: q.questionText,
        selectedAnswer: selected,
        correctAnswer: correct,
        isCorrect,
        points: q.points || 1
      };
    });

    const percentage = (score / totalPoints) * 100;

    await QuizResult.create({
      school,
      quizId: quiz._id,
      studentId,
      sessionId,
      answers,
      score,
      totalPoints,
      percentage,
      results,
      timeSpent
    });

    await QuizSession.deleteOne({ _id: session._id });

    res.json({ score, totalPoints, percentage, results });
  } catch (error) {
    res.status(500).json({ message: 'Error submitting attempt', error: error.message });
  }
};

// ---------------------------
// 5. Get My Quiz Results
// ---------------------------
exports.getMyResults = async (req, res) => {
  try {
    const school = toObjectId(req.user.school);
    const results = await QuizResult.find({ studentId: req.user._id, school })
      .populate('quizId', 'title subject');

    res.json(results);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching results', error: error.message });
  }
};
