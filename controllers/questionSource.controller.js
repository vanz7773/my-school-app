const QuestionSource = require("../models/QuestionSource");

exports.createSource = async (req, res) => {
  try {
    const {
      title,
      subjectId,
      paper,
      year,
      sourceType,
      pdfUrl,
    } = req.body;

    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!title || !subjectId || !paper || !sourceType || !pdfUrl) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    const source = await QuestionSource.create({
      title,
      subjectId,
      paper,
      year,
      sourceType,
      pdfUrl,
      uploadedBy: req.user._id,
    });

    res.status(201).json(source);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: "This question source already exists",
      });
    }

    res.status(500).json({
      message: "Failed to create question source",
      error: err.message,
    });
  }
};

exports.getSources = async (req, res) => {
  try {
    const sources = await QuestionSource.find()
      .populate("subjectId", "name")
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 });

    res.json(sources);
  } catch (err) {
    res.status(500).json({
      message: "Failed to fetch question sources",
    });
  }
};

exports.archiveSource = async (req, res) => {
  try {
    const { id } = req.params;

    const source = await QuestionSource.findById(id);
    if (!source) {
      return res.status(404).json({ message: "Source not found" });
    }

    source.status = "archived";
    await source.save();

    res.json({ message: "Question source archived" });
  } catch (err) {
    res.status(500).json({
      message: "Failed to archive source",
    });
  }
};
