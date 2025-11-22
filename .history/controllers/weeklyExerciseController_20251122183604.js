const mongoose = require('mongoose');
const WeeklyExercise = require('../models/WeeklyExercise');
const Class = require('../models/Class');
const Teacher = require('../models/Teacher');
const Term = require("../models/term");
const Subject = require("../models/Subject");

/**
 * @desc Add or update weekly exercise count
 * @route POST /api/exercises
 * @access Teacher
 */
exports.addOrUpdateExercise = async (req, res) => {
  try {
    const { classId, week, count, termId } = req.body;

    // Validate input
    const missing = [];
    if (!classId) missing.push('classId');
    if (week === undefined) missing.push('week');
    if (count === undefined) missing.push('count');
    if (!termId) missing.push('termId');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`
      });
    }

    if (!mongoose.Types.ObjectId.isValid(classId) || !mongoose.Types.ObjectId.isValid(termId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ID format'
      });
    }

    const weekNum = parseInt(week);
    if (isNaN(weekNum) || weekNum < 1) {
      return res.status(400).json({
        success: false,
        message: 'Week must be a positive integer'
      });
    }

    if (typeof count !== 'number' || count < 0 || !Number.isInteger(count)) {
      return res.status(400).json({
        success: false,
        message: 'Count must be a non-negative integer'
      });
    }

    // Parallel validation checks
    const [term, cls, teacher] = await Promise.all([
      Term.findOne({ _id: termId, school: req.user.school }),
      Class.findOne({ _id: classId, school: req.user.school }),
      Teacher.findOne({ user: req.user._id, school: req.user.school })
    ]);

    if (!term) {
      return res.status(404).json({
        success: false,
        message: 'Term not found in your school'
      });
    }
    if (!cls) {
      return res.status(404).json({
        success: false,
        message: 'Class not found in your school'
      });
    }
    if (!teacher) {
      return res.status(403).json({
        success: false,
        message: 'Teacher not authorized for this school'
      });
    }

    // Check teacher assignment to class
    const teacherAssigned = cls.teachers.some(
      t => t.toString() === teacher.user.toString()
    );

    if (!teacherAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Teacher not assigned to this class'
      });
    }

    // Validate week range
    if (weekNum < 1 || weekNum > term.weeks) {
      return res.status(400).json({
        success: false,
        message: `Week must be between 1 and ${term.weeks}`
      });
    }

    // Determine current week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const termStart = new Date(term.startDate);
    const termEnd = new Date(term.endDate);

    let currentWeek = 0;
    if (today >= termStart && today <= termEnd) {
      const diffTime = Math.abs(today - termStart);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      currentWeek = Math.min(Math.ceil(diffDays / 7), term.weeks);
    } else if (today > termEnd) {
      currentWeek = term.weeks + 1;
    }

    // Find existing record
    const existing = await WeeklyExercise.findOne({
      teacher: teacher._id,
      class: classId,
      week: weekNum,
      term: termId,
      school: req.user.school
    });

    if (existing && existing.finalized) {
      return res.status(403).json({
        success: false,
        message: `Week ${weekNum} exercises have been finalized`
      });
    }

    // Create or update
    let result;
    if (existing) {
      existing.totalExercises = count;
      result = await existing.save();
    } else {
      result = await WeeklyExercise.create({
        teacher: teacher._id,
        class: classId,
        week: weekNum,
        term: termId,
        totalExercises: count,
        school: req.user.school,
        finalized: currentWeek > 0 && weekNum < currentWeek
      });
    }

    // Populate with multi-subject support
    const populatedResult = await WeeklyExercise.findById(result._id)
      .populate({
        path: "teacher",
        select: "subjects user",
        populate: [
          { path: "user", select: "name" },
          { path: "subjects", select: "name shortName" }
        ]
      })
      .populate("class", "name level")
      .populate("term", "term academicYear");

    const responseData = {
      ...populatedResult.toObject(),
      lastUpdated: populatedResult.updatedAt,
      teacher: {
        name: populatedResult.teacher.user.name,
        subjects: populatedResult.teacher.subjects
      }
    };

    res.status(existing ? 200 : 201).json({
      success: true,
      data: responseData,
      message: existing ? "Exercise count updated" : "Exercise count added"
    });

  } catch (err) {
    console.error("[Exercise Update Error]", err);
    res.status(500).json({
      success: false,
      message: "Error processing exercise data",
      error: err.message
    });
  }
};

/**
 * @desc Update existing exercise
 * @route PATCH /api/exercises/:exerciseId
 * @access Teacher
 */
exports.updateExercise = async (req, res) => {
  try {
    const { exerciseId } = req.params;
    const { count } = req.body;

    if (!mongoose.Types.ObjectId.isValid(exerciseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid exercise ID format"
      });
    }

    if (typeof count !== "number" || count < 0 || !Number.isInteger(count)) {
      return res.status(400).json({
        success: false,
        message: "Count must be a non-negative integer"
      });
    }

    const existing = await WeeklyExercise.findOne({
      _id: exerciseId,
      school: req.user.school
    }).populate({
      path: "teacher",
      populate: [
        { path: "user", select: "name" },
        { path: "subjects", select: "name shortName" }
      ]
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Exercise record not found"
      });
    }

    if (existing.teacher.user._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only update your own exercises"
      });
    }

    if (existing.finalized) {
      return res.status(403).json({
        success: false,
        message: "Cannot update finalized exercises"
      });
    }

    existing.totalExercises = count;
    const updatedExercise = await existing.save();

    res.json({
      success: true,
      data: {
        ...updatedExercise.toObject(),
        lastUpdated: updatedExercise.updatedAt,
        teacher: {
          name: existing.teacher.user.name,
          subjects: existing.teacher.subjects
        }
      },
      message: "Exercise updated successfully"
    });

  } catch (err) {
    console.error("[Update Exercise Error]", err);
    res.status(500).json({
      success: false,
      message: "Failed to update exercise",
      error: err.message
    });
  }
};

/**
 * @desc Bulk update exercises
 * @route POST /api/exercises/bulk-update
 * @access Teacher/Admin
 */
exports.bulkUpdateExercises = async (req, res) => {
  try {
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      return res.status(400).json({
        success: false,
        message: "Updates must be an array"
      });
    }

    const results = [];
    const now = new Date();

    for (const update of updates) {
      if (!mongoose.Types.ObjectId.isValid(update.exerciseId)) {
        results.push({
          exerciseId: update.exerciseId,
          success: false,
          message: "Invalid exercise ID"
        });
        continue;
      }

      const exercise = await WeeklyExercise.findOne({
        _id: update.exerciseId,
        school: req.user.school
      }).populate({
        path: "teacher",
        populate: [
          { path: "user", select: "name" },
          { path: "subjects", select: "name shortName" }
        ]
      });

      if (!exercise) {
        results.push({
          exerciseId: update.exerciseId,
          success: false,
          message: "Exercise not found"
        });
        continue;
      }

      const ownsRecord =
        exercise.teacher.user._id.toString() === req.user._id.toString();

      if (!ownsRecord && req.user.role !== "admin") {
        results.push({
          exerciseId: update.exerciseId,
          success: false,
          message: "Not authorized"
        });
        continue;
      }

      if (exercise.finalized) {
        results.push({
          exerciseId: update.exerciseId,
          success: false,
          message: "Exercise is finalized"
        });
        continue;
      }

      exercise.totalExercises = update.count;
      await exercise.save();

      results.push({
        exerciseId: exercise._id,
        success: true,
        lastUpdated: now,
        teacher: {
          name: exercise.teacher.user.name,
          subjects: exercise.teacher.subjects
        }
      });
    }

    res.json({
      success: true,
      data: results,
      message: "Bulk update completed",
      stats: {
        total: updates.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      }
    });

  } catch (err) {
    console.error("[Bulk Update Error]", err);
    res.status(500).json({
      success: false,
      message: "Failed to process bulk update",
      error: err.message
    });
  }
};

/**
 * @desc Finalize week
 * @route POST /api/exercises/finalize
 * @access Admin
 */
exports.finalizeWeek = async (req, res) => {
  try {
    const { week, termId } = req.body;
    const weekNum = parseInt(week);

    if (isNaN(weekNum) || weekNum < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid week number"
      });
    }

    if (!mongoose.Types.ObjectId.isValid(termId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid term ID"
      });
    }

    const term = await Term.findOne({
      _id: termId,
      school: req.user.school
    });

    if (!term) {
      return res.status(404).json({
        success: false,
        message: "Term not found"
      });
    }

    if (weekNum < 1 || weekNum > term.weeks) {
      return res.status(400).json({
        success: false,
        message: `Week must be between 1 and ${term.weeks}`
      });
    }

    const result = await WeeklyExercise.updateMany(
      {
        school: req.user.school,
        term: termId,
        week: weekNum,
        finalized: false
      },
      { $set: { finalized: true } }
    );

    res.json({
      success: true,
      message: `Week ${weekNum} exercises finalized`,
      finalizedCount: result.modifiedCount
    });

  } catch (err) {
    console.error("[Finalize Week Error]", err);
    res.status(500).json({
      success: false,
      message: "Error finalizing week",
      error: err.message
    });
  }
};

/**
 * @desc Get exercise summary
 * @route GET /api/exercises/summary
 * @access Teacher/Admin
 */
exports.getExerciseSummary = async (req, res) => {
  try {
    console.log("📘 [getExerciseSummary] Starting summary fetch...");
    const { classId, termId, week, page = 1, limit = 10, finalized } = req.query;

    if (!classId || !termId) {
      return res
        .status(400)
        .json({ message: "classId and termId are required" });
    }

    const query = { class: classId, term: termId };
    if (week) query.week = parseInt(week);
    if (finalized !== undefined && finalized !== "") {
      query.finalized = finalized === "true";
    }

    // Populate teacher with subjects[]
    const exercises = await WeeklyExercise.find(query)
      .populate({
        path: "teacher",
        populate: [
          { path: "user", select: "name email" },
          { path: "subjects", select: "name _id shortName" },
        ]
      })
      .populate("class", "name level")
      .populate("term", "term academicYear")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await WeeklyExercise.countDocuments(query);

    // Build summary response
    const summary = exercises.map(ex => {
      const teacher = ex.teacher || {};

      const subjects = Array.isArray(teacher.subjects)
        ? teacher.subjects.map(s => ({
            _id: s._id,
            name: s.name,
            shortName: s.shortName
          }))
        : [];

      return {
        _id: ex._id,
        class: ex.class,
        term: ex.term,
        teacher: {
          _id: teacher._id,
          name: teacher.user?.name || "Unknown Teacher",
          subjects
        },
        totalExercises: ex.totalExercises || 0,
        week: ex.week,
        finalized: ex.finalized,
        createdAt: ex.createdAt,
        updatedAt: ex.updatedAt
      };
    });

    res.status(200).json({
      success: true,
      data: summary,
      meta: {
        totalItems: total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });

  } catch (err) {
    console.error("❌ [getExerciseSummary] Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch exercise summary",
      error: err.message
    });
  }
};
