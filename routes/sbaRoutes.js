const express = require("express");
const router = express.Router();
const sbaController = require("../controllers/sbaController");
const { protect, restrictTo } = require("../middlewares/authMiddleware");

// =========================================================
// SBA ROUTES
// =========================================================

// ---------------------------
// Teacher / Class Teacher
// ---------------------------

// 1️⃣ Download tailored SBA template for a teacher
router.get(
  "/download/:teacherId",
  protect,
  restrictTo("teacher", "admin", "parent"),
  sbaController.downloadClassTemplate
);

// 2️⃣ Upload filled SBA template
router.post(
  "/upload",
  protect,
  restrictTo("teacher", "admin"),
  sbaController.uploadMiddleware,
  sbaController.uploadClassTemplate
);

// ---------------------------
// Admin (System-Level)
// ---------------------------

// 3️⃣ Super-admin: upload a global blank template permanently
router.post(
  "/admin/upload-template",
  protect,
  restrictTo("admin"),
  sbaController.uploadGlobalTemplate
);

// 4️⃣ Admin: download full SBA workbook for any class
router.get(
  "/admin/download/:classId",
  protect,
  restrictTo("admin"),
  sbaController.adminDownloadClassWorkbook
);

// ---------------------------
// Online JSON Editing
// ---------------------------

// 5️⃣ Get a teacher's subject sheet in JSON (for online editing UI)
router.get(
  "/subject/:teacherId",
  protect,
  restrictTo("teacher", "admin"),
  sbaController.getSubjectSheet
);

// 6️⃣ Save updates to a teacher's subject sheet from JSON
router.post(
  "/subject/save",
  protect,
  restrictTo("teacher", "admin"),
  sbaController.saveSubjectSheet
);

// ---------------------------
// Report Card Workflow (Modern)
// ---------------------------

// 7️⃣ Upload full REPORT sheet PDF (exported manually from Excel)
router.post(
  "/report-card/upload-pdf",
  protect,
  restrictTo("teacher", "admin"),
  sbaController.uploadReportSheetPDF
);

// 8️⃣ Student: get my report sheet (download link)
router.get(
  "/report-card/my-pdf/:studentId/:termId",
  protect,
  restrictTo("student", "parent", "admin"),
  sbaController.getMyReportSheet
);

// ---------------------------
// Class Performance Analytics
// ---------------------------


// 1️⃣1️⃣ Get overall subject total for ALL classes under a school
router.get(
  "/overall-subject-average/:classId",
  protect,
  restrictTo("teacher", "admin"),
  sbaController.getOverallSubjectAverage  // ✅ Updated: now expects schoolId, not classId
);
// In your routes file
router.get('/class-averages-chart',protect,
  restrictTo("admin"), sbaController.getClassAveragesForChart);
// =========================================================
// EXPORT ROUTER
// =========================================================
module.exports = router;
