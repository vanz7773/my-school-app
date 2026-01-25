const express = require("express");
const router = express.Router();

const {
  createSource,
  getSources,
  archiveSource,
} = require("../../controllers/questionSource.controller");

// No middleware — admin routes assumed secure
router.post("/", createSource);
router.get("/", getSources);
router.patch("/:id/archive", archiveSource);

module.exports = router;
