const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { parsePdfStructure } = require("../utils/pdfStructureParser");

const router = express.Router();

// temporary upload folder
const upload = multer({
  dest: path.join(__dirname, "../tmp"),
});

/**
 * POST /api/test/pdf-structure
 * Upload a PDF and return parsed structure
 */
router.post("/pdf-structure", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "PDF file is required" });
    }

    const pdfPath = req.file.path;

    const result = await parsePdfStructure(pdfPath);

    // cleanup temp file
    fs.unlinkSync(pdfPath);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
