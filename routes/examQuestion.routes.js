const express = require("express");
const router = express.Router();
const ExamQuestion = require("../models/ExamQuestion");

/**
 * Create exam question
 */
router.post("/", async (req, res) => {
  try {
    const question = await ExamQuestion.create(req.body);
    res.status(201).json(question);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Get questions (filters supported)
 */
router.get("/", async (req, res) => {
  try {
    const filter = {};

    if (req.query.blockId) filter.blockId = req.query.blockId;
    if (req.query.paper) filter.paper = req.query.paper;
    if (req.query.section) filter.section = req.query.section;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const questions = await ExamQuestion.find(filter).sort({
      questionNumber: 1,
    });

    res.json(questions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Update question (draft only)
 */
router.patch("/:id", async (req, res) => {
  try {
    const question = await ExamQuestion.findById(req.params.id);
    if (!question) return res.status(404).json({ message: "Question not found" });

    if (question.status !== "draft") {
      return res
        .status(400)
        .json({ message: "Approved questions cannot be edited" });
    }

    Object.assign(question, req.body);
    await question.save();

    res.json(question);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Approve question
 */
router.patch("/:id/approve", async (req, res) => {
  try {
    const question = await ExamQuestion.findById(req.params.id);
    if (!question) return res.status(404).json({ message: "Question not found" });

    question.status = "approved";
    await question.save();

    res.json({ message: "Question approved" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Archive question
 */
router.patch("/:id/archive", async (req, res) => {
  try {
    const question = await ExamQuestion.findById(req.params.id);
    if (!question) return res.status(404).json({ message: "Question not found" });

    question.status = "archived";
    await question.save();

    res.json({ message: "Question archived" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
