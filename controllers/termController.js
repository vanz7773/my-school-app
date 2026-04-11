const mongoose = require('mongoose');
const Term = require("../models/term");
const { isWeekend } = require('../utils/dateHelpers');

// 🟢 Create a new term
exports.createTerm = async (req, res) => {
  try {
    const { school, academicYear, term, startDate, endDate } = req.body;

    // Validate academic year format
    const academicYearRegex = /^(\d{4})-(\d{4})$/;
    if (!academicYearRegex.test(academicYear)) {
      return res.status(400).json({
        success: false,
        message: 'Academic year must be in format YYYY-YYYY (e.g., 2025-2026)'
      });
    }

    // Validate dates within academic year
    const [startYear, endYear] = academicYear.split('-').map(Number);
    const termStartYear = new Date(startDate).getFullYear();
    const termEndYear = new Date(endDate).getFullYear();

    if (
      termStartYear < startYear || termStartYear > endYear ||
      termEndYear < startYear || termEndYear > endYear
    ) {
      return res.status(400).json({
        success: false,
        message: 'Term dates must fall within the academic year'
      });
    }

    // Check for existing term
    const existingTerm = await Term.findOne({ school, academicYear, term });
    if (existingTerm) {
      return res.status(409).json({
        success: false,
        message: `${term} already exists for academic year ${academicYear}`
      });
    }

    // -------------------------------------------------------
    // ⭐ WEEK CALCULATIONS
    // -------------------------------------------------------

    // Week number always starts at 1
    const weekNumber = 1;

    // Calculate total weeks in the term aligning to Monday-Friday
    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    let weekCount = 0;
    let current = new Date(start);

    while (current <= end) {
      weekCount++;
      let dayOfWeek = current.getDay();
      let daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
      
      let weekEnd = new Date(current);
      weekEnd.setDate(weekEnd.getDate() + daysToFriday);
      weekEnd.setHours(23, 59, 59, 999);
      
      current = new Date(weekEnd);
      current.setDate(current.getDate() + 3); // Friday + 3 = Monday
      current.setHours(0, 0, 0, 0);
    }

    // Keep the weekStartDate as Monday of the first week for DB
    const day = start.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const weekStartDate = new Date(start);
    const diffToMonday = (day === 0 ? -6 : 1 - day); // shift to Monday
    weekStartDate.setDate(start.getDate() + diffToMonday);

    // -------------------------------------------------------
    // ⭐ CREATE TERM
    // -------------------------------------------------------
    const newTerm = new Term({
      school,
      academicYear,
      term,
      startDate,
      endDate,
      weeks: weekCount,
      weekNumber,
      weekStartDate
    });

    await newTerm.save();

    res.status(201).json({
      success: true,
      message: `${term} created successfully for ${academicYear}`,
      term: newTerm
    });

  } catch (error) {
    console.error('Create Term Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create term'
    });
  }
};


// 🟢 Get all terms for a school
exports.getTermsBySchool = async (req, res) => {
  try {
    const { school } = req.query;

    if (!school) {
      return res.status(400).json({
        success: false,
        message: "School ID is required",
      });
    }

    // Normalize the incoming school parameter
    let schoolId;
    if (typeof school === "object") {
      if (school.id) {
        schoolId = school.id.toString();
      } else if (school._id) {
        schoolId = school._id.toString();
      } else {
        schoolId = String(school);
      }
    } else {
      schoolId = school.toString();
    }

    let terms = [];

    if (mongoose.Types.ObjectId.isValid(schoolId)) {
      // ✅ Query using ObjectId if valid
      terms = await Term.find({ school: new mongoose.Types.ObjectId(schoolId) })
        .sort({ academicYear: -1, term: 1 })
        .lean();
    } else {
      // ✅ Fallback: query using string schoolId
      console.warn("⚠️ Using raw string school ID:", schoolId);
      terms = await Term.find({ school: schoolId })
        .sort({ academicYear: -1, term: 1 })
        .lean();
    }

    const termsByAcademicYear = terms.reduce((acc, term) => {
      if (!acc[term.academicYear]) acc[term.academicYear] = [];
      acc[term.academicYear].push(term);
      return acc;
    }, {});

    return res.status(200).json({
      success: true,
      count: terms.length,
      termsByAcademicYear,
      allTerms: terms,
    });
  } catch (error) {
    console.error("Get Terms Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to get terms",
    });
  }
};


// 🟢 Get academic years
exports.getAcademicYears = async (req, res) => {
  try {
    // ✅ Prefer user's school from auth (multi-tenant safety)
    const user = req.user;
    let schoolId;

    if (user?.school) {
      // Normalize school: it could be ObjectId, {_id}, or {id, name}
      if (typeof user.school === 'string') {
        schoolId = user.school;
      } else if (user.school._id) {
        schoolId = user.school._id.toString();
      } else if (user.school.id) {
        schoolId = user.school.id.toString();
      } else {
        // If it's an object but doesn't have expected properties, try to use it as is
        schoolId = String(user.school);
      }
    }

    // Fall back to query param (for admin dashboards)
    if (!schoolId && req.query.school) {
      // Handle case where query param might be an object stringified
      let querySchool = req.query.school;
      if (typeof querySchool === 'object') {
        // If it's an object, try to extract id
        if (querySchool.id) {
          schoolId = querySchool.id.toString();
        } else if (querySchool._id) {
          schoolId = querySchool._id.toString();
        } else {
          schoolId = String(querySchool);
        }
      } else {
        schoolId = querySchool.toString();
      }
    }

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        message: 'School ID is required'
      });
    }

    // Clean up schoolId - remove any unwanted characters
    schoolId = schoolId.replace(/[^a-f0-9]/gi, '');

    // Validate if it's a valid ObjectId format (24 hex characters)
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid School ID format'
      });
    }

    // ✅ Now always a clean ObjectId string
    const academicYears = await Term.find({ school: new mongoose.Types.ObjectId(schoolId) }).distinct('academicYear');

    const sortedYears = academicYears.sort((a, b) => {
      const [aStart] = a.split('-').map(Number);
      const [bStart] = b.split('-').map(Number);
      return bStart - aStart;
    });

    res.status(200).json({
      success: true,
      count: sortedYears.length,
      academicYears: sortedYears
    });

  } catch (error) {
    console.error('Get Academic Years Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get academic years'
    });
  }
};

// 🟢 Get weeks in a term
exports.getTermWeeks = async (req, res) => {
  try {
    const { school, academicYear, term, termId } = req.query;
    const missing = [];
    if (!school) missing.push('school');
    // either termId OR both academicYear and term are required
    if (!termId && (!academicYear || !term)) {
      missing.push('termId OR (academicYear AND term)');
    }

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required parameters: ${missing.join(', ')}`
      });
    }

    // Handle school parameter normalization
    let schoolId;
    if (typeof school === 'object') {
      if (school.id) {
        schoolId = school.id.toString();
      } else if (school._id) {
        schoolId = school._id.toString();
      } else {
        schoolId = String(school);
      }
    } else {
      schoolId = school.toString();
    }

    // Clean up schoolId
    schoolId = schoolId.replace(/[^a-f0-9]/gi, '');

    // Validate school ID format
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid School ID format'
      });
    }

    let searchObj = { school: new mongoose.Types.ObjectId(schoolId) };
    if (termId && mongoose.Types.ObjectId.isValid(termId)) {
      searchObj._id = new mongoose.Types.ObjectId(termId);
    } else {
      searchObj.academicYear = academicYear;
      searchObj.term = term;
    }

    const foundTerm = await Term.findOne(searchObj).lean();

    if (!foundTerm) {
      return res.status(404).json({
        success: false,
        message: 'Term not found'
      });
    }

    const startDate = new Date(foundTerm.startDate);
    const endDate = new Date(foundTerm.endDate);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    const weeks = [];
    let currentDate = new Date(startDate);
    let weekNumber = 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalInstructionalDays = 0;
    let totalCalendarDays = 0;

    while (currentDate <= endDate) {
      const weekStart = new Date(currentDate);
      let weekEnd = new Date(weekStart);
      
      let dayOfWeek = weekStart.getDay();
      let daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
      weekEnd.setDate(weekEnd.getDate() + daysToFriday);
      weekEnd.setHours(23, 59, 59, 999);

      if (weekEnd > endDate) weekEnd = new Date(endDate);

      let instructionalDays = 0;
      const currentDay = new Date(weekStart);
      const weekDays = [];

      while (currentDay <= weekEnd) {
        const weekend = isWeekend(currentDay);
        if (!weekend) instructionalDays++;
        weekDays.push({
          date: new Date(currentDay),
          dayName: currentDay.toLocaleDateString('en-US', { weekday: 'long' }),
          isWeekend: weekend,
          isInstructionalDay: !weekend
        });
        currentDay.setDate(currentDay.getDate() + 1);
      }

      const normalizedWeekStart = new Date(weekStart);
      normalizedWeekStart.setHours(0, 0, 0, 0);
      const normalizedWeekEnd = new Date(weekEnd);
      
      // Expand conceptually to Sunday to include the weekend within isCurrent context
      let weekEndInclusive = new Date(weekEnd);
      weekEndInclusive.setDate(weekEndInclusive.getDate() + 2); 
      weekEndInclusive.setHours(23, 59, 59, 999);

      weeks.push({
        weekNumber,
        label: `Week ${weekNumber}`,
        startDate: weekStart,
        endDate: weekEnd,
        instructionalDays,
        calendarDays: weekDays.length,
        isCurrent: today >= normalizedWeekStart && today <= weekEndInclusive,
        isPast: today > weekEndInclusive,
        isFuture: today < normalizedWeekStart,
        weekDays,
        isPartialWeek: instructionalDays < 5
      });

      totalInstructionalDays += instructionalDays;
      totalCalendarDays += weekDays.length;
      
      const actualFriday = new Date(weekStart);
      actualFriday.setDate(actualFriday.getDate() + daysToFriday);
      currentDate = new Date(actualFriday);
      currentDate.setDate(currentDate.getDate() + 3); // Move to Monday
      currentDate.setHours(0, 0, 0, 0);
      weekNumber++;
    }

    res.status(200).json({
      success: true,
      termInfo: {
        academicYear: foundTerm.academicYear,
        term: foundTerm.term,
        startDate: foundTerm.startDate,
        endDate: foundTerm.endDate,
        totalWeeks: foundTerm.weeks, // Use stored value
        totalInstructionalDays,
        totalCalendarDays,
        instructionalRatio: (totalInstructionalDays / totalCalendarDays * 100).toFixed(1) + '%'
      },
      weeks,
      currentWeek: weeks.find(w => w.isCurrent) || null
    });

  } catch (error) {
    console.error('Get Term Weeks Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate term weeks'
    });
  }
};

// 🟢 Get term by ID
exports.getTermById = async (req, res) => {
  try {
    const term = await Term.findById(req.params.id);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: 'Term not found'
      });
    }

    res.status(200).json({ success: true, term });

  } catch (error) {
    console.error('Get Term By ID Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get term'
    });
  }
};

// ✅ UPDATE term
exports.updateTerm = async (req, res) => {
  try {
    const term = await Term.findById(req.params.id);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: 'Term not found'
      });
    }

    const { academicYear, term: newTermName, startDate, endDate } = req.body;
    const updatedStartDate = startDate || term.startDate;
    const updatedEndDate = endDate || term.endDate;

    // Recalculate weeks when dates change
    if (startDate || endDate) {
      const start = new Date(updatedStartDate);
      const end = new Date(updatedEndDate);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);

      let weekCount = 0;
      let current = new Date(start);

      while (current <= end) {
        weekCount++;
        let dayOfWeek = current.getDay();
        let daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
        
        let weekEnd = new Date(current);
        weekEnd.setDate(weekEnd.getDate() + daysToFriday);
        weekEnd.setHours(23, 59, 59, 999);
        
        current = new Date(weekEnd);
        current.setDate(current.getDate() + 3); // Friday + 3 = Monday
        current.setHours(0, 0, 0, 0);
      }
      term.weeks = weekCount; // Update weeks count
    }

    // Validate academic year if changed
    if (academicYear) {
      const academicYearRegex = /^(\d{4})-(\d{4})$/;
      if (!academicYearRegex.test(academicYear)) {
        return res.status(400).json({
          success: false,
          message: 'Academic year must be in format YYYY-YYYY'
        });
      }

      const [startYear, endYear] = academicYear.split('-').map(Number);
      const termStartYear = new Date(updatedStartDate).getFullYear();
      const termEndYear = new Date(updatedEndDate).getFullYear();

      if (
        termStartYear < startYear || termStartYear > endYear ||
        termEndYear < startYear || termEndYear > endYear
      ) {
        return res.status(400).json({
          success: false,
          message: 'Term dates must fall within the academic year'
        });
      }

      term.academicYear = academicYear;
    }

    // Update other fields
    term.term = newTermName || term.term;
    term.startDate = updatedStartDate;
    term.endDate = updatedEndDate;

    await term.save();

    res.status(200).json({
      success: true,
      message: 'Term updated successfully',
      term
    });

  } catch (error) {
    console.error('❌ Error updating term:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// ✅ DELETE term
exports.deleteTerm = async (req, res) => {
  try {
    const term = await Term.findByIdAndDelete(req.params.id);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: 'Term not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Term deleted successfully'
    });

  } catch (error) {
    console.error('❌ Error deleting term:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// ✅ Get a term by school, academicYear, and term name
exports.findTermByQuery = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      console.warn("❌ No authenticated user on request");
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - No user info'
      });
    }

    // Extract school ID from user object
    let schoolId;
    if (user.school) {
      if (typeof user.school === 'string') {
        schoolId = user.school;
      } else if (user.school._id) {
        schoolId = user.school._id.toString();
      } else if (user.school.id) {
        schoolId = user.school.id.toString();
      } else {
        schoolId = String(user.school);
      }
    }

    const { academicYear, term } = req.query;

    console.log("➡️ Hitting /api/term/find endpoint");
    console.log("🔐 User school:", user.school);
    console.log("📦 Query:", { term, academicYear });

    if (!schoolId || !academicYear || !term) {
      console.warn("❌ Missing required query parameters");
      return res.status(400).json({
        success: false,
        message: 'Missing school, academicYear, or term',
      });
    }

    // Clean up schoolId
    schoolId = schoolId.replace(/[^a-f0-9]/gi, '');

    // Validate school ID format
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid School ID format'
      });
    }

    const foundTerm = await Term.findOne({
      school: new mongoose.Types.ObjectId(schoolId),
      academicYear,
      term
    });

    if (!foundTerm) {
      console.warn("❌ Term not found for query:", { schoolId, academicYear, term });
      return res.status(404).json({
        success: false,
        message: 'Term not found'
      });
    }

    console.log("✅ Term found:", foundTerm._id);
    return res.json({
      success: true,
      term: foundTerm
    });

  } catch (err) {
    console.error("❌ Error during term lookup:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

// Get current week info
exports.getCurrentWeek = async (req, res) => {
  try {
    const { school } = req.query;

    if (!school) {
      return res.status(400).json({
        success: false,
        message: 'School ID is required'
      });
    }

    // Handle school parameter normalization
    let schoolId;
    if (typeof school === 'object') {
      if (school.id) {
        schoolId = school.id.toString();
      } else if (school._id) {
        schoolId = school._id.toString();
      } else {
        schoolId = String(school);
      }
    } else {
      schoolId = school.toString();
    }

    // Clean up schoolId
    schoolId = schoolId.replace(/[^a-f0-9]/gi, '');

    // Validate school ID format
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid School ID format'
      });
    }

    const today = new Date();

    // Find current term by date bounds
    let currentTerm = await Term.findOne({
      school: new mongoose.Types.ObjectId(schoolId),
      startDate: { $lte: today },
      endDate: { $gte: today }
    }).lean();

    // If no term specifically encompasses today, fall back to the currently active term
    if (!currentTerm) {
      currentTerm = await Term.findOne({
        school: new mongoose.Types.ObjectId(schoolId),
        isCurrent: true
      }).lean();
    }

    // Still no active term configured at all
    if (!currentTerm) {
      return res.status(200).json({
        current: 0,
        total: 0,
        termName: 'No active term',
        academicYear: ''
      });
    }

    // Calculate current week mapping through Monday-Friday weeks
    const startDate = new Date(currentTerm.startDate);
    const endDate = new Date(currentTerm.endDate);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    let currentDate = new Date(startDate);
    let calculatedWeek = 0;

    while (currentDate <= endDate) {
      calculatedWeek++;
      
      let dayOfWeek = currentDate.getDay();
      let daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
      let weekEnd = new Date(currentDate);
      weekEnd.setDate(weekEnd.getDate() + daysToFriday);
      
      // Expand bounding box for weekend so `today` handles Saturday/Sunday safely
      let weekEndInclusive = new Date(weekEnd);
      weekEndInclusive.setDate(weekEndInclusive.getDate() + 2); // Includes Saturday & Sunday
      weekEndInclusive.setHours(23, 59, 59, 999);

      if (today >= currentDate && today <= weekEndInclusive) {
        break; // Today falls in this week
      }

      currentDate = new Date(weekEnd);
      currentDate.setDate(currentDate.getDate() + 3); // Move to next Monday
      currentDate.setHours(0, 0, 0, 0);
    }

    if (today > endDate) {
      calculatedWeek = currentTerm.weeks;
    } else if (today < startDate) {
      calculatedWeek = 0;
    }

    const currentWeek = Math.min(calculatedWeek, currentTerm.weeks);

    res.json({
      current: currentWeek,
      total: currentTerm.weeks,
      termName: currentTerm.term,
      academicYear: currentTerm.academicYear,
      termId: currentTerm._id
    });

  } catch (error) {
    console.error("Error getting current week:", error);
    res.status(500).json({
      current: 0,
      total: 0,
      termName: 'Error',
      academicYear: ''
    });
  }
};