const express = require("express");
const router = express.Router();
const sbaV2Controller = require("../controllers/sbaV2Controller");
const sbaV2ReportController = require("../controllers/sbaV2ReportController");
const { protect } = require("../middlewares/authMiddleware");

// GET /api/v1/sba-v2/marks
router.get("/marks", protect, sbaV2Controller.getSubjectMarks);

// POST /api/v1/sba-v2/marks
router.post("/marks", protect, sbaV2Controller.saveSubjectMarks);

// GET /api/v1/sba-v2/reports
router.get("/reports", protect, sbaV2ReportController.getClassReportCards);

module.exports = router;
