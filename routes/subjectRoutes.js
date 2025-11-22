// routes/subjects.js
const express = require("express");
const router = express.Router();
const subjectController = require("../controllers/subjectController");
const { protect } = require("../middlewares/authMiddleware");
// optional isAdmin middleware if you want to protect /sync
// const { isAdmin } = require("../middlewares/roleMiddleware");

// Get the global/default subjects (formatted) - helpful for dropdowns
router.get("/global/list", protect, subjectController.getGlobalSubjects);

// Create or update a global subject (body: { name, shortName?, aliases? })
router.post("/", protect, subjectController.createSubject);

// Get all global subjects (will create defaults if needed)
router.get("/", protect, subjectController.getSubjects);

// Normalize teacher subjects -> subject ObjectIds (global-only)
router.put("/normalize", protect, subjectController.normalizeTeacherSubjects);

// Ensure global default subjects exist
router.post("/sync", protect, subjectController.syncDefaultSubjectsForAllSchools);

module.exports = router;
