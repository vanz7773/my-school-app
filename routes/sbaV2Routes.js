const express = require("express");
const router = express.Router();
const sbaV2Controller = require("../controllers/sbaV2Controller");
const { protect } = require("../middlewares/authMiddleware");

// GET /api/v1/sba-v2/marks
router.get("/marks", protect, sbaV2Controller.getSubjectMarks);

// POST /api/v1/sba-v2/marks
router.post("/marks", protect, sbaV2Controller.saveSubjectMarks);

module.exports = router;
