const express = require("express");
const router = express.Router();
const sbaV2Controller = require("../controllers/sbaV2Controller");
const sbaV2ReportController = require("../controllers/sbaV2ReportController");
const { protect, restrictTo } = require("../middlewares/authMiddleware");

// GET /api/v1/sba-v2/marks
router.get("/marks", protect, restrictTo("teacher", "admin", "superadmin"), sbaV2Controller.getSubjectMarks);

// GET /api/v1/sba-v2/class-averages-chart
router.get(
  "/class-averages-chart",
  protect,
  restrictTo("admin", "superadmin"),
  sbaV2Controller.getClassAveragesForChart
);

// POST /api/v1/sba-v2/marks
router.post("/marks", protect, restrictTo("teacher", "admin", "superadmin"), sbaV2Controller.saveSubjectMarks);

// POST /api/v1/sba-v2/report-card/upload-pdf
router.post(
  "/report-card/upload-pdf",
  protect,
  restrictTo("teacher", "admin", "superadmin"),
  sbaV2Controller.uploadGeneratedReportCards
);

// Student PDFs uploaded from the V2 report flow, including previous classes/years.
router.get('/report-card/my-pdf/:studentId/:termId', protect, restrictTo('student', 'parent'), require('../controllers/sbaController').getMyReportSheet);

// GET /api/v1/sba-v2/reports
router.get("/reports", protect, sbaV2ReportController.getClassReportCards);

module.exports = router;
