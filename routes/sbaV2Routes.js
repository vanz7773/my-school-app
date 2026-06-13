const express = require("express");
const router = express.Router();
const sbaV2Controller = require("../controllers/sbaV2Controller");
const sbaV2ReportController = require("../controllers/sbaV2ReportController");
const { protect, restrictTo } = require("../middlewares/authMiddleware");

// GET /api/v1/sba-v2/marks
router.get("/marks", protect, sbaV2Controller.getSubjectMarks);

// POST /api/v1/sba-v2/marks
router.post("/marks", protect, sbaV2Controller.saveSubjectMarks);

// POST /api/v1/sba-v2/report-card/upload-pdf
router.post(
  "/report-card/upload-pdf",
  protect,
  restrictTo("teacher", "admin", "superadmin"),
  sbaV2Controller.uploadGeneratedReportCards
);

// GET /api/v1/sba-v2/reports
router.get("/reports", protect, sbaV2ReportController.getClassReportCards);

module.exports = router;
