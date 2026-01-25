const express = require("express");
const router = express.Router();
const QuestionBlock = require("../models/QuestionBlock");

/**
 * Create a question block
 */
router.post("/", async (req, res) => {
  try {
    const block = await QuestionBlock.create(req.body);
    res.status(201).json(block);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Get blocks (optionally by source)
 */
router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.sourceId) {
      filter.sourceId = req.query.sourceId;
    }

    const blocks = await QuestionBlock.find(filter).sort({ order: 1 });
    res.json(blocks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Update block (draft only)
 */
router.patch("/:id", async (req, res) => {
  try {
    const block = await QuestionBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ message: "Block not found" });

    if (block.status !== "draft") {
      return res.status(400).json({ message: "Approved blocks cannot be edited" });
    }

    Object.assign(block, req.body);
    await block.save();

    res.json(block);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Approve block
 */
router.patch("/:id/approve", async (req, res) => {
  try {
    const block = await QuestionBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ message: "Block not found" });

    block.status = "approved";
    await block.save();

    res.json({ message: "Block approved" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
