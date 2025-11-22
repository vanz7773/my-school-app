// controllers/quizController.js
const Quiz = require("../models/QuizSession");
const generateQuestionsFromText = require("../services/quizGenerator");

exports.generateQuiz = async (req, res) => {
  try {
    const { title, subject, grade, difficulty, notesText, questions } = req.body;

    let finalQuestions = questions;

    // If questions not provided but notesText is, auto-generate
    if ((!questions || questions.length === 0) && notesText) {
      console.log("⚡ Auto-generating quiz questions from notes...");
      finalQuestions = await generateQuestionsFromText(notesText, {
        grade,
        subject,
        difficulty,
      });

      // Optionally limit to 20 if your AI produces 50
      finalQuestions = finalQuestions.slice(0, 50);
    }

    // Validation
    if (!finalQuestions || finalQuestions.length === 0) {
      return res.status(400).json({
        message: "Either provide questions or notesText to generate them.",
      });
    }

    // Create quiz
    const newQuiz = await Quiz.create({
      title,
      subject,
      grade,
      difficulty,
      notesText,
      questions: finalQuestions,
    });

    res.status(201).json({
      message: "Quiz created successfully",
      quiz: newQuiz,
    });
  } catch (error) {
    console.error("❌ Quiz creation failed:", error);
    res.status(500).json({
      message: "Failed to generate quiz",
      error: error.message,
    });
  }
};
