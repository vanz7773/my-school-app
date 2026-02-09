const path = require("path");
const fs = require("fs");
const multer = require("multer");
const ExcelJS = require("exceljs");
const admin = require("firebase-admin"); // initialized elsewhere
const SbaTemplate = require("../models/SbaTemplate");
const Class = require("../models/Class");
const Student = require("../models/Student");
const School = require("../models/School");
const Teacher = require("../models/Teacher");
const XlsxPopulate = require("xlsx-populate");
const Term = require("../models/term");
const User = require("../models/User");
const { PDFDocument } = require("pdf-lib");
const { findTextPosition } = require("../utils/pdfTextLocator");
const SchoolInfo = require("../models/SchoolInfo");
const Notification = require("../models/Notification");
const axios = require("axios");
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();
const StudentAttendance = require("../models/StudentAttendance");
const mongoose = require("mongoose");
const Subject = require("../models/Subject");

// ==============================
// Helper: Resolve class names (SBA / Reports)
// ==============================
function resolveClassNames(classDoc) {
  if (!classDoc) {
    return {
      className: "Unassigned",
      classDisplayName: "Unassigned"
    };
  }

  const className = classDoc.name || "Unassigned";

  const classDisplayName =
    classDoc.displayName ||
    (classDoc.stream ? `${classDoc.name}${classDoc.stream}` : classDoc.name);

  return { className, classDisplayName };
}

async function sendPush(userIds, title, body) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false,
  }).lean();

  const validTokens = tokens
    .map(t => t.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (validTokens.length === 0) return;

  const messages = validTokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data: { type: "report-card" }
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error("Push error:", err);
    }
  }
}

// ------------------ Multer setup ------------------
const upload = multer({ dest: "uploads/" });
exports.uploadMiddleware = upload.single("file");

// ------------------ Helpers ------------------
function templateKeyToDestination(key) {
  if (!key) return null;
  let cleaned = String(key).trim();
  if (/^SBA-/i.test(cleaned)) cleaned = cleaned.replace(/^SBA-/i, "");
  return `templates/SBA-${cleaned.replace(/[^A-Za-z0-9_\-]/g, "_")}.xlsx`;
}

// JHS check - flexible
function isJhsClass(className = "") {
  return /\b(basic\s*7|basic\s*8|basic\s*9|grade\s*7|grade\s*8|grade\s*9|jhs\s*1|jhs\s*2|jhs\s*3|class\s*7|class\s*8|class\s*9)\b/i.test(className);
}

// BASIC 1–6 check - flexible
function isBasic1to6(className = "") {
  return /\b(basic\s*[1-6]|grade\s*[1-6]|class\s*[1-6]|primary\s*[1-6]|std\s*[1-6]|p\s*[1-6])\b/i.test(className);
}

// ✅ NEW: Nursery & KG checks - flexible
function isNurseryClass(className = "") {
  return /\b(nursery\s*[1-2]|pre-nursery|nurs\s*[1-2])\b/i.test(className);
}

function isKgClass(className = "") {
  return /\b(kg\s*[1-2]|kindergarten\s*[1-2]|k\s*g\s*[1-2])\b/i.test(className);
}

// Helper function for logging (add this at the top of your controller)
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data)}` : `[${timestamp}] ${message}`;
  console.log(logEntry);
  return logEntry;
}

/**
 * Determines SBA master key with flexible class name mappings
 */
function getClassLevelKey(className) {
  if (!className) return null;

  const cleaned = className.trim().replace(/\s+/g, "_").toUpperCase();

  console.log(`📝 Raw class name: "${className}" → Cleaned: "${cleaned}"`);

  // 📚 FLEXIBLE CLASS NAME MAPPINGS
  const classMappings = {
    // Map GRADE_X to BASIC_X
    'GRADE_1': 'BASIC_1',
    'GRADE_2': 'BASIC_2',
    'GRADE_3': 'BASIC_3',
    'GRADE_4': 'BASIC_4',
    'GRADE_5': 'BASIC_5',
    'GRADE_6': 'BASIC_6',
    'GRADE_7': 'BASIC_7',
    'GRADE_8': 'BASIC_8',
    'GRADE_9': 'BASIC_9',

    // Map CLASS_X to BASIC_X
    'CLASS_1': 'BASIC_1',
    'CLASS_2': 'BASIC_2',
    'CLASS_3': 'BASIC_3',
    'CLASS_4': 'BASIC_4',
    'CLASS_5': 'BASIC_5',
    'CLASS_6': 'BASIC_6',
    'CLASS_7': 'BASIC_7',
    'CLASS_8': 'BASIC_8',
    'CLASS_9': 'BASIC_9',

    // Map PRIMARY_X to BASIC_X
    'PRIMARY_1': 'BASIC_1',
    'PRIMARY_2': 'BASIC_2',
    'PRIMARY_3': 'BASIC_3',
    'PRIMARY_4': 'BASIC_4',
    'PRIMARY_5': 'BASIC_5',
    'PRIMARY_6': 'BASIC_6',

    // Map STD_X to BASIC_X
    'STD_1': 'BASIC_1',
    'STD_2': 'BASIC_2',
    'STD_3': 'BASIC_3',
    'STD_4': 'BASIC_4',
    'STD_5': 'BASIC_5',
    'STD_6': 'BASIC_6',

    // Map JHS_X to BASIC_X+3
    'JHS_1': 'BASIC_7',
    'JHS_2': 'BASIC_8',
    'JHS_3': 'BASIC_9',

    // Map P_X to BASIC_X
    'P_1': 'BASIC_1',
    'P_2': 'BASIC_2',
    'P_3': 'BASIC_3',
    'P_4': 'BASIC_4',
    'P_5': 'BASIC_5',
    'P_6': 'BASIC_6',

    // KG variations
    'KINDERGARTEN_1': 'KG_1',
    'KINDERGARTEN_2': 'KG_2',
    'KINDERGARTEN_3': 'KG_3',
    'K_G_1': 'KG_1',
    'K_G_2': 'KG_2',

    // Nursery variations
    'NURSERY_ONE': 'NURSERY_1',
    'NURSERY_TWO': 'NURSERY_2',
    'PRE_NURSERY': 'NURSERY_1',
  };

  // Check if we have a direct mapping
  if (classMappings[cleaned]) {
    const mappedKey = classMappings[cleaned];
    console.log(`🗺️ Class name mapped: "${cleaned}" → "${mappedKey}"`);
    return mappedKey;
  }

  // Check patterns with regex for flexibility
  const patterns = [
    // Match GRADE/CLASS/PRIMARY/STD/P followed by number
    {
      regex: /^(GRADE|CLASS|PRIMARY|STD|P)_([1-9])$/i,
      replacer: (match, prefix, num) => {
        const number = parseInt(num);
        return `BASIC_${number}`; // BASIC_1 through BASIC_9
      }
    },
    // Match JHS followed by number
    {
      regex: /^JHS_([1-3])$/i,
      replacer: (match, num) => `BASIC_${parseInt(num) + 6}` // JHS_1 → BASIC_7
    },
    // Match KG variations
    {
      regex: /^(KG|KINDERGARTEN|K_G)_([1-3])$/i,
      replacer: (match, prefix, num) => `KG_${num}`
    },
    // Match Nursery variations
    {
      regex: /^(NURSERY|PRE_NURSERY|NURS)_([1-2]|ONE|TWO)$/i,
      replacer: (match, prefix, num) => {
        if (num === 'ONE') return 'NURSERY_1';
        if (num === 'TWO') return 'NURSERY_2';
        return `NURSERY_${num}`;
      }
    }
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern.regex);
    if (match) {
      const mappedKey = pattern.replacer(...match);
      console.log(`🔀 Pattern matched: "${cleaned}" → "${mappedKey}"`);
      return mappedKey;
    }
  }

  // Check if it's already a standard key
  const standardKeys = [
    'BASIC_1', 'BASIC_2', 'BASIC_3', 'BASIC_4', 'BASIC_5', 'BASIC_6',
    'BASIC_7', 'BASIC_8', 'BASIC_9',
    'KG_1', 'KG_2', 'KG_3',
    'NURSERY_1', 'NURSERY_2'
  ];

  if (standardKeys.includes(cleaned)) {
    console.log(`✅ Already standard key: "${cleaned}"`);
    return cleaned;
  }

  // Try to extract number from any class name
  const numberMatch = cleaned.match(/(\d+)/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1]);
    if (num >= 1 && num <= 6) {
      const key = `BASIC_${num}`;
      console.log(`🔢 Extracted number ${num} from "${cleaned}" → "${key}"`);
      return key;
    } else if (num >= 7 && num <= 9) {
      const key = `BASIC_${num}`;
      console.log(`🔢 Extracted number ${num} from "${cleaned}" → "${key}"`);
      return key;
    }
  }

  console.log(`⚠️ No mapping found for: "${cleaned}", using as-is`);
  return cleaned;
}

// Helper function to debug available templates
async function debugAvailableTemplates(schoolId, classLevelKey) {
  console.log(`[DEBUG] Checking templates for school: ${schoolId}, classKey: ${classLevelKey}`);

  // 1. Check global templates
  const globalTemplates = await SbaTemplate.find({}).lean();
  console.log(`[DEBUG] Global templates available: ${globalTemplates.map(t => t.key).join(', ')}`);

  // 2. Check school's sbaMaster
  const school = await School.findById(schoolId).select('sbaMaster').lean();
  if (school?.sbaMaster) {
    console.log(`[DEBUG] School SBA master keys: ${Object.keys(school.sbaMaster).join(', ')}`);
  } else {
    console.log('[DEBUG] School has no SBA master');
  }

  // 3. Check all class names in the school to understand patterns
  const classes = await Class.find({ school: schoolId }).select('name displayName').lean();
  console.log(`[DEBUG] All class names in school:`);
  classes.forEach(cls => {
    console.log(`[DEBUG]   - "${cls.name}" (display: "${cls.displayName}") → key: "${getClassLevelKey(cls.name)}"`);
  });

  return {
    globalTemplates: globalTemplates.map(t => t.key),
    schoolKeys: school?.sbaMaster ? Object.keys(school.sbaMaster) : [],
    classNames: classes.map(c => ({ name: c.name, key: getClassLevelKey(c.name) }))
  };
}

// Helper function for flexible template fallback
async function findFlexibleTemplate(school, classLevelKey) {
  console.log(`🔍 Starting flexible template search for key: ${classLevelKey}`);

  // 1. First, check for alternative global template keys
  const globalTemplateKeys = await SbaTemplate.find({}).distinct('key');
  console.log(`🔍 Available global template keys: ${globalTemplateKeys.join(', ')}`);

  let globalTemplate = null;
  let usedKey = classLevelKey;

  // Try exact match first
  globalTemplate = await SbaTemplate.findOne({ key: classLevelKey }).lean();

  // If not found, try case-insensitive
  if (!globalTemplate) {
    globalTemplate = await SbaTemplate.findOne({
      key: { $regex: new RegExp(`^${classLevelKey}$`, 'i') }
    }).lean();
    if (globalTemplate) {
      console.log(`🔍 Found global template (case-insensitive): ${globalTemplate.key}`);
      usedKey = globalTemplate.key;
    }
  }

  // If still not found, try to find any template with same number
  if (!globalTemplate) {
    const numMatch = classLevelKey.match(/\d+/);
    if (numMatch) {
      const num = numMatch[0];
      const templatesWithSameNumber = await SbaTemplate.find({
        key: new RegExp(num + '$')
      }).lean();

      console.log(`🔍 Templates with number ${num}: ${templatesWithSameNumber.map(t => t.key).join(', ')}`);

      if (templatesWithSameNumber.length > 0) {
        // Prioritize BASIC templates for numbers 1-9
        const basicTemplate = templatesWithSameNumber.find(t =>
          t.key.toUpperCase().startsWith('BASIC_')
        );
        if (basicTemplate) {
          globalTemplate = basicTemplate;
          usedKey = basicTemplate.key;
          console.log(`🔍 Found BASIC template with same number: ${usedKey}`);
        } else {
          globalTemplate = templatesWithSameNumber[0];
          usedKey = globalTemplate.key;
          console.log(`🔍 Found template with same number: ${usedKey}`);
        }
      }
    }
  }

  // If still not found, check school's existing templates for similar key
  if (!globalTemplate && school?.sbaMaster) {
    const schoolKeys = Object.keys(school.sbaMaster);
    console.log(`🔍 Checking school templates for fallback: ${schoolKeys.join(', ')}`);

    // Look for templates with same number
    const numMatch = classLevelKey.match(/\d+/);
    if (numMatch) {
      const num = numMatch[0];
      const similarSchoolKey = schoolKeys.find(key => key.includes(num));

      if (similarSchoolKey) {
        console.log(`🔍 Found school template with same number: ${similarSchoolKey}`);
        // We can't return this directly, but we can use it to find corresponding global template
        globalTemplate = await SbaTemplate.findOne({
          key: { $regex: new RegExp(similarSchoolKey.replace(/\d+$/, ''), 'i') }
        }).lean();

        if (globalTemplate) {
          usedKey = globalTemplate.key;
          console.log(`🔍 Found corresponding global template: ${usedKey}`);
        }
      }
    }
  }

  return {
    found: !!globalTemplate,
    template: globalTemplate,
    usedKey,
    availableKeys: globalTemplateKeys
  };
}

// Helper function to find similar key in school SBA master
function findSimilarSchoolKey(school, classLevelKey) {
  if (!school?.sbaMaster) return null;

  const allKeys = Object.keys(school.sbaMaster);
  console.log(`🔍 Looking for similar key among: ${allKeys.join(', ')}`);

  // 1. Case-insensitive exact match
  const caseInsensitiveMatch = allKeys.find(key =>
    key.toUpperCase() === classLevelKey.toUpperCase()
  );
  if (caseInsensitiveMatch) {
    console.log(`🔍 Found case-insensitive match: ${caseInsensitiveMatch}`);
    return caseInsensitiveMatch;
  }

  // 2. Match by number
  const numMatch = classLevelKey.match(/\d+/);
  if (numMatch) {
    const num = numMatch[0];
    const sameNumberKey = allKeys.find(key => {
      const keyNum = (key.match(/\d+/) || [])[0];
      return keyNum === num;
    });

    if (sameNumberKey) {
      console.log(`🔍 Found key with same number (${num}): ${sameNumberKey}`);
      return sameNumberKey;
    }
  }

  // 3. Match by level (Basic vs JHS vs KG vs Nursery)
  const levelMatch = allKeys.find(key => {
    const level1 = classLevelKey.split('_')[0]; // e.g., "BASIC" from "BASIC_1"
    const level2 = key.split('_')[0]; // e.g., "BASIC" from "BASIC_2"
    return level1 === level2;
  });

  if (levelMatch) {
    console.log(`🔍 Found key with same level: ${levelMatch}`);
    return levelMatch;
  }

  console.log(`🔍 No similar key found for: ${classLevelKey}`);
  return null;
}

async function getStudentTermAttendance(studentId, termId, schoolId) {
  const result = await StudentAttendance.aggregate([
    {
      $match: {
        student: new mongoose.Types.ObjectId(studentId),
        termId: new mongoose.Types.ObjectId(termId),
        school: new mongoose.Types.ObjectId(schoolId)
      }
    },
    {
      $group: {
        _id: "$student",
        totalAttendance: { $sum: "$totalPresent" }
      }
    }
  ]);

  return result[0]?.totalAttendance || 0;
}

// =========================================================
// ✅ SBA CONTROLLER ROUTES
// =========================================================

exports.downloadClassTemplate = async (req, res) => {
  let tempFilePath = null;
  let logMessages = []; // Array to collect all logs for debugging

  // Helper function to clean strings for HTTP headers
  const safeForHeader = (str) => {
    if (!str) return '';
    return String(str)
      .replace(/[\r\n\t]/g, ' ')  // Replace control characters with spaces
      .replace(/[^\x20-\x7E]/g, '') // Remove non-printable ASCII
      .substring(0, 1000); // Limit length
  };

  const log = (message, data = null) => {
    const timestamp = new Date().toISOString();
    const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data)}` : `[${timestamp}] ${message}`;
    console.log(logEntry);
    logMessages.push(logEntry);
    return logEntry;
  };

  try {
    log("🚀 ========== START DOWNLOAD CLASS TEMPLATE ==========");
    log("Request received", {
      teacherId: req.params.teacherId,
      query: req.query,
      headers: req.headers,
      timestamp: new Date().toISOString()
    });

    const { teacherId } = req.params;
    if (!teacherId) {
      log("❌ ERROR: teacherId is required but missing");
      return res.status(400).json({
        message: "teacherId is required",
        logs: logMessages
      });
    }

    log("🔍 Looking for teacher", { teacherId });
    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) {
      log("❌ ERROR: Teacher not found");
      return res.status(404).json({
        message: "Teacher not found",
        logs: logMessages
      });
    }
    log("✅ Teacher found", {
      teacherId: teacher._id,
      teacherName: teacher.name,
      userId: teacher.user
    });

    const userId = teacher.user;

    // --------------------------------------------------
    // 1️⃣ Resolve target class (explicit, no guessing)
    // --------------------------------------------------
    const classDocByTeacher = await Class.findOne({ classTeacher: userId }).lean();
    const isClassTeacher = !!classDocByTeacher;

    let targetClassId;

    if (isClassTeacher) {
      targetClassId = classDocByTeacher._id;
    } else {
      targetClassId = req.query.classId;
    }

    if (!targetClassId) {
      return res.status(400).json({
        message: "Class selection required",
        classes: teacher.assignedClasses
      });
    }

    // --------------------------------------------------
    // 1️⃣b Validate class belongs to teacher’s school
    // --------------------------------------------------
    const classDocFinal = await Class.findOne({
      _id: targetClassId,
      school: teacher.school
    }).lean();

    if (!classDocFinal) {
      return res.status(400).json({
        message: "Invalid class selection"
      });
    }

    log("✅ Final class document", {
      classId: classDocFinal._id,
      className: classDocFinal.name,
      displayName: classDocFinal.displayName,
      classTeacher: classDocFinal.classTeacher,
      school: classDocFinal.school
    });

    let subject = null;

    // --------------------------------------------------
    // 2️⃣ Resolve subject (SUBJECT TEACHERS ONLY)
    // --------------------------------------------------
    if (!isClassTeacher) {

      const subjectId = req.query.subjectId;

      if (!subjectId) {
        return res.status(400).json({
          message: "Subject selection required"
        });
      }

      // ✅ ONLY check: subject exists in this school
      const subjectDoc = await Subject.findOne({
        _id: subjectId,
        school: teacher.school
      }).lean();

      if (!subjectDoc) {
        return res.status(400).json({
          message: "Invalid subject selection"
        });
      }

      subject = subjectDoc.shortName || subjectDoc.name;

      log("📚 Subject resolved", {
        subjectId: subjectDoc._id,
        subject,
        classId: classDocFinal._id,
        teacherId: teacher._id
      });
    }






    const students = await Student.find({ class: targetClassId })
      .populate("user", "name")
      .lean();

    log("📊 Students in class", {
      count: students.length,
      studentIds: students.map(s => s._id),
      studentNames: students.map(s => s.user?.name || 'No name')
    });

    if (!students.length) {
      log("❌ ERROR: No students found for this class");
      return res.status(400).json({
        message: "No students found for this class",
        logs: logMessages
      });
    }

    const school = await School.findById(classDocFinal.school).lean();
    if (!school) {
      log("❌ ERROR: School not found");
      return res.status(404).json({
        message: "School not found",
        logs: logMessages
      });
    }

    log("✅ School found", {
      schoolId: school._id,
      schoolName: school.name,
      hasSbaMaster: !!school.sbaMaster,
      sbaMasterKeys: Object.keys(school.sbaMaster || {})
    });

    // Term / Academic Year info
    let classTeacherName = "N/A";
    if (classDocFinal.classTeacher) {
      const ct = await User.findById(classDocFinal.classTeacher).lean();
      classTeacherName = ct?.name || "N/A";
      log("👨‍🏫 Class teacher info", {
        classTeacherId: classDocFinal.classTeacher,
        classTeacherName
      });
    }

    let termName = "N/A";
    let academicYear = "N/A";
    let resolvedTermId = null;

    log("📅 STARTING TERM RESOLUTION LOGIC");
    log("Request query termId", { queryTermId: req.query.termId });

    try {
      let termDoc = null;

      // 🔥 1️⃣ FIRST PRIORITY: termId from frontend filter
      if (req.query.termId) {
        log("🔄 Step 1: Looking for term by frontend termId", {
          termId: req.query.termId,
          schoolId: classDocFinal.school
        });

        termDoc = await Term.findOne({
          _id: req.query.termId,
          school: classDocFinal.school,
        }).lean();

        log("🔍 Step 1 result", {
          found: !!termDoc,
          termDoc: termDoc ? {
            _id: termDoc._id,
            term: termDoc.term,
            academicYear: termDoc.academicYear,
            startDate: termDoc.startDate,
            endDate: termDoc.endDate
          } : null
        });
      } else {
        log("⚠️ Step 1: No termId in query params");
      }

      // 2️⃣ Use class term if available
      if (!termDoc && classDocFinal.termId) {
        log("🔄 Step 2: Looking for term by class.termId", {
          classTermId: classDocFinal.termId
        });

        termDoc = await Term.findById(classDocFinal.termId).lean();

        log("🔍 Step 2 result", {
          found: !!termDoc,
          termDoc: termDoc ? {
            _id: termDoc._id,
            term: termDoc.term,
            academicYear: termDoc.academicYear
          } : null
        });
      }

      // 3️⃣ Fallback to active term by date
      if (!termDoc) {
        const today = new Date();
        log("🔄 Step 3: Looking for active term by date", {
          today: today.toISOString(),
          schoolId: classDocFinal.school
        });

        termDoc = await Term.findOne({
          school: classDocFinal.school,
          startDate: { $lte: today },
          endDate: { $gte: today },
        }).lean();

        log("🔍 Step 3 result", {
          found: !!termDoc,
          termDoc: termDoc ? {
            _id: termDoc._id,
            term: termDoc.term,
            startDate: termDoc.startDate,
            endDate: termDoc.endDate
          } : null
        });
      }

      // 4️⃣ Final fallback: most recent term
      if (!termDoc) {
        log("🔄 Step 4: Looking for most recent term");

        termDoc = await Term.findOne({ school: classDocFinal.school })
          .sort({ startDate: -1 })
          .lean();

        log("🔍 Step 4 result", {
          found: !!termDoc,
          termDoc: termDoc ? {
            _id: termDoc._id,
            term: termDoc.term,
            startDate: termDoc.startDate
          } : null
        });
      }

      // ✅ Apply resolved term
      if (termDoc) {
        termName = termDoc.term || "N/A";
        academicYear = termDoc.academicYear || "N/A";
        resolvedTermId = termDoc._id;

        log("✅ TERM RESOLVED SUCCESSFULLY", {
          resolvedTermId,
          termName,
          academicYear
        });
      } else {
        log("⚠️ WARNING: No term document found at all");
      }

    } catch (e) {
      log("❌ ERROR in term resolution", {
        error: e.message,
        stack: e.stack
      });
    }

    log("📊 Final term info", {
      resolvedTermId: resolvedTermId ? resolvedTermId.toString() : null,
      termName,
      academicYear,
      queryTermId: req.query.termId
    });

    const bucket = admin.storage().bucket();
    const { className, classDisplayName } = resolveClassNames(classDocFinal);
    log("📝 Class name resolution", { className, classDisplayName });

    const classLevelKey = getClassLevelKey(className);
    log("🔑 Class level key", { classLevelKey });


    log("📚 Teacher subject", { subject });

    // ====================================================
    // ✅ FLEXIBLE TEMPLATE HANDLING SECTION (UPDATED)
    // ====================================================
    log("🔍 Checking school SBA master with flexible matching", {
      sbaMasterExists: !!school.sbaMaster,
      classLevelKey,
      hasKey: school.sbaMaster?.[classLevelKey] ? true : false,
      allSchoolKeys: Object.keys(school.sbaMaster || {})
    });

    // ✅ FLEXIBLE TEMPLATE FALLBACK
    let actualMasterKey = classLevelKey;

    // If school doesn't have this key, try to find a similar one
    if (!school.sbaMaster?.[classLevelKey]) {
      log("📄 School master missing for exact key, checking alternatives...");

      const similarKey = findSimilarSchoolKey(school, classLevelKey);

      if (similarKey) {
        log(`🔄 Using similar key instead: ${similarKey}`);
        actualMasterKey = similarKey;
        log(`✅ Found school template for key: ${similarKey}`);
      } else {
        log("❌ No similar school key found, will attempt to clone global template");
      }
    }

    if (!school.sbaMaster?.[actualMasterKey]) {
      log("📄 School master missing, attempting to clone global template with flexible search");

      const templateSearch = await findFlexibleTemplate(school, classLevelKey);

      log("🔍 Global template search result", {
        found: !!templateSearch.template,
        originalKey: classLevelKey,
        usedKey: templateSearch.usedKey,
        availableKeys: templateSearch.availableKeys,
        template: templateSearch.template ? {
          path: templateSearch.template.path,
          url: templateSearch.template.url,
          key: templateSearch.template.key
        } : null
      });

      if (!templateSearch.template) {
        // Run debug to show what's available
        const debugInfo = await debugAvailableTemplates(school._id, classLevelKey);

        log("❌ ERROR: No suitable global template found");
        return res.status(404).json({
          message: `SBA template for "${className}" has not been uploaded yet.`,
          details: {
            requestedClass: className,
            requestedKey: classLevelKey,
            availableGlobalTemplates: debugInfo.globalTemplates,
            availableSchoolTemplates: debugInfo.schoolKeys,
            classNamesInSchool: debugInfo.classNames,
            suggestion: `Please upload a template for "${classLevelKey}" or use one of: ${debugInfo.globalTemplates.join(', ')}`
          },
          logs: logMessages.slice(-20) // Last 20 logs for context
        });
      }

      // Clone the found template
      let buffer;
      if (templateSearch.template.path) {
        log("📥 Downloading template from Firebase path", { path: templateSearch.template.path });
        [buffer] = await bucket.file(templateSearch.template.path).download();
      } else if (templateSearch.template.url) {
        log("🌐 Downloading template from URL", { url: templateSearch.template.url });
        const axios = require("axios");
        const resp = await axios.get(templateSearch.template.url, { responseType: "arraybuffer" });
        buffer = resp.data;
      } else {
        // ✅ MULTI-TENANT SAFE FALLBACK
        const derivedPath = templateKeyToDestination(templateSearch.template.key);

        log("⚠️ Global template missing DB file reference — using derived Firebase path", {
          derivedPath,
          templateKey: templateSearch.template.key
        });

        const file = bucket.file(derivedPath);
        const [exists] = await file.exists();

        if (!exists) {
          log("❌ ERROR: Derived Firebase template does not exist", { derivedPath });

          return res.status(404).json({
            message: `Global SBA template file missing in storage for ${templateSearch.template.key}`,
            expectedPath: derivedPath,
            logs: logMessages
          });
        }

        // 🔥 DOWNLOAD IMMEDIATELY (THIS WAS MISSING)
        const [downloadedBuffer] = await file.download();

        buffer = downloadedBuffer; // ✅ CRITICAL LINE

        // Patch runtime metadata (no DB writes)
        templateSearch.template.path = derivedPath;
        templateSearch.template.url =
          `https://storage.googleapis.com/${bucket.name}/${derivedPath}`;
      }



      // Use the original classLevelKey for the school path, not the found key
      const schoolPath = `templates/${school._id}/${classLevelKey}_master.xlsx`;
      tempFilePath = path.join("uploads", `clone_${school._id}_${Date.now()}.xlsx`);

      log("💾 Saving temporary file", { tempFilePath });
      fs.writeFileSync(tempFilePath, buffer);

      log("☁️ Uploading to Firebase Storage", { destination: schoolPath });
      await bucket.upload(tempFilePath, {
        destination: schoolPath,
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      await bucket.file(schoolPath).makePublic();

      log("🧹 Cleaning up temp file");
      fs.unlinkSync(tempFilePath);
      tempFilePath = null;

      await School.findByIdAndUpdate(school._id, {
        $set: {
          [`sbaMaster.${classLevelKey}`]: {
            path: schoolPath,
            url: `https://storage.googleapis.com/${bucket.name}/${schoolPath}`,
            sourceTemplate: templateSearch.template.key, // Track which template was used
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      });

      // Update local school object for this request
      school.sbaMaster = school.sbaMaster || {};
      school.sbaMaster[classLevelKey] = {
        path: schoolPath,
        url: `https://storage.googleapis.com/${bucket.name}/${schoolPath}`,
      };

      log("✅ School master initialized", {
        schoolPath,
        url: school.sbaMaster[classLevelKey].url,
        sourceTemplate: templateSearch.template.key
      });
    }

    // Download master file
    log("📥 Downloading master file from Firebase", {
      path: school.sbaMaster?.[classLevelKey]?.path || school.sbaMaster?.[actualMasterKey]?.path
    });

    const masterFilePath = school.sbaMaster?.[classLevelKey]?.path || school.sbaMaster?.[actualMasterKey]?.path;
    if (!masterFilePath) {
      log("❌ ERROR: No master file path found");
      return res.status(500).json({
        message: "No master file path found",
        logs: logMessages
      });
    }

    const masterFile = bucket.file(masterFilePath);
    const [masterBuffer] = await masterFile.download();
    log("✅ Master file downloaded", { size: masterBuffer.length });

    // Load workbook
    log("📊 Loading workbook with XlsxPopulate");
    const xpWorkbook = await XlsxPopulate.fromDataAsync(masterBuffer);
    log("✅ Workbook loaded", {
      sheetCount: xpWorkbook.sheets().length,
      sheetNames: xpWorkbook.sheets().map(s => s.name())
    });

    // Fill sheets
    log("✏️ Filling sheet data");
    const homeSheet = xpWorkbook.sheet("HOME") || xpWorkbook.sheet("Home");
    if (homeSheet) {
      homeSheet.cell("B9").value(school.name || "N/A");
      homeSheet.cell("B12").value(classTeacherName || "N/A");
      homeSheet.cell("K9").value(classDisplayName);
      homeSheet.cell("I18").value(termName || "N/A");
      homeSheet.cell("K18").value(students.length || 0);
      log("✅ HOME sheet filled");
    }

    const home2Sheet = xpWorkbook.sheet("HOME2") || xpWorkbook.sheet("Home2");
    if (home2Sheet) {
      home2Sheet.cell("F8").value(school.name || "N/A");
      home2Sheet.cell("P8").value(classDisplayName);
      home2Sheet.cell("P11").value(termName || "N/A");
      home2Sheet.cell("Q14").value(academicYear || "N/A");
      log("✅ HOME2 sheet filled");
    }

    const namesSheet = xpWorkbook.sheet("NAMES");
    if (namesSheet) {
      const startRow = 9;
      students.forEach((stu, i) => {
        namesSheet.cell(`E${startRow + i}`).value(stu.user?.name || "N/A");
      });
      log("✅ NAMES sheet filled with students");
    }

    // ===============================
    // 📊 ATTENDANCE INJECTION
    // ===============================
    log("📊 STARTING ATTENDANCE INJECTION");
    log("Attendance injection prerequisites", {
      hasResolvedTermId: !!resolvedTermId,
      resolvedTermId: resolvedTermId ? resolvedTermId.toString() : null,
      studentCount: students.length
    });

    if (resolvedTermId) {
      log("✅ Attendance injection enabled - term found");
      const reportSheet = xpWorkbook.sheet("REPORT");

      if (!reportSheet) {
        log("⚠️ WARNING: REPORT sheet not found in template");
      } else {
        log("✅ REPORT sheet found");

        // Inject attendance for each student
        for (let i = 0; i < students.length; i++) {
          const student = students[i];

          log(`📊 Processing attendance for student ${i + 1}/${students.length}`, {
            studentId: student._id,
            studentName: student.user?.name
          });

          const totalAttendance = await getStudentTermAttendance(
            student._id,
            resolvedTermId,
            classDocFinal.school
          );

          log(`📝 Student attendance result`, {
            studentId: student._id,
            totalAttendance,
            termId: resolvedTermId.toString()
          });

          // Determine position based on class type
          let firstAttendanceRow = 30;
          let rowInterval = 40;
          let attendanceColumn = "D";

          if (isBasic1to6(className)) {
            firstAttendanceRow = 29;
            rowInterval = 39;
          }

          if (isKgClass(className) || isNurseryClass(className)) {
            firstAttendanceRow = 24;
            rowInterval = 34;
          }

          const targetRow = firstAttendanceRow + (i * rowInterval);
          const targetCell = `${attendanceColumn}${targetRow}`;

          log(`📝 Writing attendance to cell`, {
            targetCell,
            attendanceValue: totalAttendance,
            rowInterval,
            firstAttendanceRow
          });

          reportSheet.cell(targetCell).value(totalAttendance);
          reportSheet.cell(targetCell).style("numberFormat", "0");
        }

        log("✅ Attendance writing completed!");
      }
    } else {
      log("⚠️ SKIPPING ATTENDANCE INJECTION: No resolvedTermId found");
    }

    // 🧹 Remove unused sheets if not class teacher
    log("🎭 Checking teacher role for sheet pruning", {
      isClassTeacher,
      subject
    });


    if (!isClassTeacher) {
      log("🔪 Pruning sheets for subject teacher");
      const allSheets = xpWorkbook.sheets();
      const normalizedSubject = (subject || "").trim().toUpperCase();

      // Build keep list
      const keepList = allSheets
        .filter((s) => {
          const sheetName = s.name().trim().toUpperCase();
          return (
            sheetName === "NAMES" ||
            sheetName === "HOME" ||
            sheetName === "HOME2" ||
            sheetName === normalizedSubject
          );
        })
        .map((s) => s.name());

      log("📋 Sheets to keep", { keepList });

      // Find fallback active sheet
      const fallbackSheet =
        allSheets.find((s) => keepList.includes(s.name()) && !s.hidden()) ||
        allSheets.find((s) => !s.hidden());

      if (fallbackSheet) {
        xpWorkbook.activeSheet(fallbackSheet.name());
        log("📌 Set active sheet to", { activeSheet: fallbackSheet.name() });
      }

      // Delete everything else
      allSheets.forEach((s) => {
        const sheetName = s.name();
        if (!keepList.includes(sheetName)) {
          if (xpWorkbook.activeSheet().name() === sheetName) {
            const nextVisible = xpWorkbook
              .sheets()
              .find((x) => keepList.includes(x.name()) && !x.hidden());
            if (nextVisible) {
              xpWorkbook.activeSheet(nextVisible.name());
              log("🔄 Changed active sheet for deletion", {
                from: sheetName,
                to: nextVisible.name()
              });
            }
          }
          xpWorkbook.deleteSheet(sheetName);
          log(`🗑️ Deleted sheet: ${sheetName}`);
        }
      });

      // Handle missing subject sheet
      if (!xpWorkbook.sheet(subject)) {
        log(`⚠️ Subject sheet "${subject}" not found in template`);
      }

      log("✅ Sheet pruning completed");
    }

    // ✨ Output final file
    log("💾 Generating final buffer");
    const finalBuffer = await xpWorkbook.outputAsync("nodebuffer");
    log("✅ Final buffer generated", { size: finalBuffer.length });

    const filename = isClassTeacher
      ? `${classDisplayName}_FULL_SBA.xlsx`
      : `${subject}_SBA.xlsx`;

    log("📤 Sending response", {
      filename,
      bufferSize: finalBuffer.length,
      isClassTeacher,
      classDisplayName,
      classLevelKey,
      actualMasterKey,
      templateSource: school.sbaMaster?.[classLevelKey]?.sourceTemplate || 'direct'
    });

    // Set headers safely
    const safeFilename = safeForHeader(filename);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    // Optional: Send log count (safe string)
    res.setHeader("X-Log-Count", String(logMessages.length));

    // Only send debug logs in development mode or as base64
    if (process.env.NODE_ENV === 'development') {
      try {
        // Clean logs for headers
        const debugLogs = logMessages.slice(-20).map(log => safeForHeader(log));
        const safeLogsString = debugLogs.join(' | ');

        // Check if it's safe for headers
        if (/^[\x20-\x7E]*$/.test(safeLogsString)) {
          res.setHeader("X-Debug-Logs", safeLogsString);
        } else {
          // If not safe, encode as base64
          const encodedLogs = Buffer.from(safeLogsString).toString('base64');
          res.setHeader("X-Debug-Logs-Encoded", encodedLogs);
        }
      } catch (headerErr) {
        console.warn("Could not add debug logs to headers:", headerErr.message);
        // Continue without debug headers
      }
    }

    res.send(finalBuffer);

    log("✅ Download complete — formulas + hyperlinks preserved");
    log("========== END DOWNLOAD CLASS TEMPLATE ==========");

  } catch (err) {
    log("❌ ERROR in downloadClassTemplate", {
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });

    // Send detailed error with logs
    const safeLogs = logMessages.map(log => safeForHeader(log));

    res.status(500).json({
      message: "Server error downloading class template",
      error: err.message,
      logs: safeLogs, // Include all logs in error response
      timestamp: new Date().toISOString()
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      log("🧹 Cleaning up temporary file", { tempFilePath });
      fs.unlinkSync(tempFilePath);
    }

    // Also log to a file for persistent debugging
    try {
      const logDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const logFileName = `download_${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      const logFile = path.join(logDir, logFileName);

      fs.writeFileSync(logFile, logMessages.join('\n'));
      console.log(`📝 Full logs saved to: ${logFile}`);
    } catch (fileErr) {
      console.error("Failed to save logs to file:", fileErr);
    }
  }
};

// 2️⃣ Upload class template - UPDATED to preserve exact structure
exports.uploadClassTemplate = async (req, res) => {
  let tempFilePath = null;
  try {
    console.log("🚀 Upload class template started");

    const { teacherId } = req.body;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    if (!teacherId) return res.status(400).json({ message: "teacherId required" });

    tempFilePath = req.file.path;
    console.log(`📁 Uploaded file: ${tempFilePath}`);

    // Fetch teacher with populated user data
    const teacher = await Teacher.findById(teacherId).populate("user", "name").lean();
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    if (!teacher.assignedClasses?.length)
      return res.status(400).json({ message: "No assigned classes for this teacher" });

    const teacherName = teacher.user?.name || teacher.name || "N/A";

    console.log(`👨‍🏫 Teacher found: ${teacherName}, Subject: ${teacher.subject}`);
    console.log(`📚 Assigned classes: ${teacher.assignedClasses}`);

    const classId = teacher.assignedClasses[0];
    console.log(`🎯 Processing class ID: ${classId}`);

    const classDoc = await Class.findById(classId).lean();
    if (!classDoc) return res.status(404).json({ message: "Class not found" });

    // --------------------------------------------------
    // ✅ Resolve teacher subject(s) to STRING (Excel-safe)
    // --------------------------------------------------
    let subjectName = "";

    if (Array.isArray(teacher.subjects) && teacher.subjects.length > 0) {
      const subjectDoc = await Subject.findOne({
        _id: { $in: teacher.subjects },
        school: classDocFinal.school // 🔒 tenant safety
      }).lean();

      if (subjectDoc) {
        subjectName = subjectDoc.name || subjectDoc.shortName || "";
      }
    }

    log("📚 Resolved teacher subject", {
      rawSubjects: teacher.subjects,
      subjectName
    });

    // ✅ Always use this from now on
    const subject = subjectName;




    // ✅ Use resolveClassNames helper
    const { className, classDisplayName } = resolveClassNames(classDoc);

    console.log(`🏫 Class found: ${className} (Display: ${classDisplayName})`);
    console.log(`👑 Class Teacher from classDoc: ${classDoc.classTeacher}`);

    const school = await School.findById(classDoc.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // Term info
    let termName = "N/A";
    let academicYear = "N/A";
    try {
      let termDoc = null;

      // 1️⃣ FRONTEND-SELECTED TERM (display only)
      if (req.body.termId && mongoose.Types.ObjectId.isValid(req.body.termId)) {
        termDoc = await Term.findById(req.body.termId).lean();
      }

      // 2️⃣ CLASS-LINKED TERM (fallback)
      if (!termDoc && classDoc.termId) {
        termDoc = await Term.findById(classDoc.termId).lean();
      }

      // 3️⃣ ACTIVE TERM BY DATE
      if (!termDoc) {
        const today = new Date();
        termDoc = await Term.findOne({
          school: classDoc.school,
          startDate: { $lte: today },
          endDate: { $gte: today },
        }).lean();
      }

      // 4️⃣ MOST RECENT TERM (last fallback)
      if (!termDoc) {
        termDoc = await Term.findOne({ school: classDoc.school })
          .sort({ startDate: -1 })
          .lean();
      }

      if (termDoc) {
        termName = termDoc.term || "N/A";
        academicYear = termDoc.academicYear || "N/A";
      }

      console.log(`📅 Term: ${termName}, Academic Year: ${academicYear}`);
    } catch (err) {
      console.error("❌ Error fetching Term info (upload):", err);
    }


    // Enhanced class teacher detection
    const classTeacherId = classDoc.classTeacher;
    const isClassTeacherByUser =
      teacher.user && String(classTeacherId) === String(teacher.user._id);
    const isClassTeacherByDocId = String(classTeacherId) === String(teacher._id);
    const isClassTeacherByArray = classDoc.teachers?.some(
      (tId) => String(tId) === String(teacher._id)
    );
    const isClassTeacher = isClassTeacherByUser || isClassTeacherByDocId || isClassTeacherByArray;
    const isSubjectTeacher = teacher.subject && teacher.assignedClasses?.includes(classId);

    console.log(`ℹ️ Teacher roles for class ${className}:`);
    console.log(`   Is Class Teacher: ${isClassTeacher}`);
    console.log(`   Is Subject Teacher: ${isSubjectTeacher}`);

    const bucket = admin.storage().bucket();
    const classLevelKey = getClassLevelKey(className); // Use className for logic


    if (!school.sbaMaster?.[classLevelKey])
      return res.status(400).json({ message: "Master SBA not initialized. Please download first." });

    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [masterBuffer] = await masterFile.download();
    const masterWorkbook = await XlsxPopulate.fromDataAsync(masterBuffer);
    const teacherWorkbook = await XlsxPopulate.fromFileAsync(tempFilePath);

    console.log("📊 Workbooks loaded successfully");

    // Prefill HOME - use classDisplayName for display
    const homeSheet =
      teacherWorkbook.sheet("HOME") || teacherWorkbook.sheet("Home") || teacherWorkbook.sheet("home");
    if (homeSheet) {
      homeSheet.cell("B9").value(school.name || "");
      homeSheet.cell("B12").value(classDoc.classTeacherName || teacherName || "");
      homeSheet.cell("K9").value(classDisplayName);
      homeSheet.cell("I18").value(termName || "");
      homeSheet.cell("K18").value(classDoc.students?.length || 0);
      console.log("✅ HOME sheet prefilled");
    }

    // Prefill HOME2 - use classDisplayName for display
    const home2Sheet =
      teacherWorkbook.sheet("HOME2") || teacherWorkbook.sheet("Home2") || teacherWorkbook.sheet("home2");
    if (home2Sheet) {
      home2Sheet.cell("F8").value(school.name || "");
      home2Sheet.cell("P8").value(classDisplayName);
      home2Sheet.cell("P11").value(termName || "");
      home2Sheet.cell("Q14").value(academicYear || "");
      console.log("✅ HOME2 sheet prefilled");
    }

    // Copy helper
    function copyCellPreserve(tCell, mCell) {
      try {
        const formula = typeof tCell.formula === "function" ? tCell.formula() : null;
        if (formula) mCell.formula(formula);
        else mCell.value(tCell.value());
        const link = tCell.hyperlink?.();
        if (link) mCell.hyperlink(link);
        const style = tCell.style?.();
        if (style) mCell.style(style);
      } catch {
        mCell.value(tCell.value());
      }
    }

    let masterReplaced = false;
    let responseMessage = "Upload processed";

    // 🔁 Class Teacher: Replace full master
    if (isClassTeacher) {
      console.log("🔁 Class teacher upload detected. Replacing master file...");
      const outBuffer = await teacherWorkbook.outputAsync("nodebuffer");
      await bucket.file(school.sbaMaster[classLevelKey].path).save(outBuffer, {
        metadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await masterFile.makePublic();
      masterReplaced = true;
      responseMessage = "Full workbook replaced (class teacher)";
      console.log("✅ Master replaced successfully.");
    }

    // 🔄 Subject Teacher: Merge single sheet
    else if (isSubjectTeacher) {
      console.log("🔄 Subject teacher upload — merging single subject sheet...");

      // 🧩 Case-insensitive subject matching in teacher workbook
      const normalizedSubject = (subject || "").trim().toUpperCase();
      let teacherSheet =
        teacherWorkbook.sheet(subject) ||
        teacherWorkbook
          .sheets()
          .find((s) => s.name().trim().toUpperCase() === normalizedSubject);

      if (!teacherSheet) {
        const available = teacherWorkbook.sheets().map((s) => s.name());
        console.log(`❌ Subject sheet '${subject}' not found. Available: ${available.join(", ")}`);
        return res.status(400).json({
          message: `Uploaded file missing subject sheet '${subject}'`,
          availableSheets: available,
        });
      }
      console.log(`✅ Found subject sheet (case-insensitive): ${teacherSheet.name()}`);

      const usedRange = teacherSheet.usedRange();
      if (!usedRange)
        return res.status(400).json({ message: `No data found in '${subject}' sheet.` });

      // 🧩 Case-insensitive matching for master sheet too
      let masterSheet =
        masterWorkbook.sheet(subject) ||
        masterWorkbook
          .sheets()
          .find((s) => s.name().trim().toUpperCase() === normalizedSubject);

      if (!masterSheet) {
        console.log(`📄 Creating new subject sheet in master: ${subject}`);
        masterSheet = masterWorkbook.addSheet(subject);
      }

      const start = usedRange.startCell();
      const end = usedRange.endCell();
      for (let r = start.rowNumber(); r <= end.rowNumber(); r++) {
        for (let c = start.columnNumber(); c <= end.columnNumber(); c++) {
          copyCellPreserve(teacherSheet.cell(r, c), masterSheet.cell(r, c));
        }
      }

      console.log(`✅ Merged subject '${subject}' into master workbook.`);
      const outBuffer = await masterWorkbook.outputAsync("nodebuffer");
      await bucket.file(school.sbaMaster[classLevelKey].path).save(outBuffer, {
        metadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await masterFile.makePublic();
      masterReplaced = true;
      responseMessage = "Subject sheet merged successfully";
    }

    else {
      return res.status(400).json({ message: "Teacher not assigned to this class or subject." });
    }

    if (!masterReplaced) {
      const outBuffer = await masterWorkbook.outputAsync("nodebuffer");
      await bucket.file(school.sbaMaster[classLevelKey].path).save(outBuffer, {
        metadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await masterFile.makePublic();
    }

    res.json({
      message: responseMessage,
      url: school.sbaMaster[classLevelKey].url,
      teacherRoles: { isClassTeacher, isSubjectTeacher },
      teacherName,
      class: classDisplayName, // ✅ Return classDisplayName for frontend
    });
  } catch (err) {
    console.error("❌ Error uploading class template:", err);
    res.status(500).json({ message: "Server error uploading class template", error: err.message });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log(`🧹 Cleaned up temp file: ${tempFilePath}`);
    }
  }
};

// 3️⃣ Upload global template (super-admin)
exports.uploadGlobalTemplate = [
  upload.single("file"),
  async (req, res) => {
    let tempPath = null;
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const key = req.body.key;
      if (!key) return res.status(400).json({ message: "Template key required" });

      tempPath = req.file.path;
      const destination = templateKeyToDestination(key);
      const bucket = admin.storage().bucket();

      await bucket.upload(tempPath, {
        destination,
        metadata: { contentType: req.file.mimetype },
      });
      await bucket.file(destination).makePublic();

      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${destination}`;
      const templateDoc = await SbaTemplate.findOneAndUpdate(
        { key },
        { key, path: destination, url: publicUrl, uploadedBy: req.user?.id || null, uploadedAt: new Date() },
        { upsert: true, new: true }
      );

      res.json({ message: "Global template uploaded successfully", url: publicUrl, dbRecord: templateDoc });
    } catch (err) {
      console.error("Error uploading global template:", err);
      res.status(500).json({ message: "Failed to upload template", error: err.message });
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
];

// 4️⃣ Get teacher's subject sheet (for JSON editing)
exports.getSubjectSheet = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) return res.status(400).json({ message: "teacherId required" });

    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    if (!teacher.assignedClasses?.length) return res.status(400).json({ message: "No assigned classes for this teacher" });

    const classId = teacher.assignedClasses[0];
    const classDoc = await Class.findById(classId).lean();
    if (!classDoc) return res.status(404).json({ message: "Class not found" });
    const school = await School.findById(classDoc.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // --------------------------------------------------
    // ✅ Resolve teacher subject(s) to STRING (Excel-safe)
    // --------------------------------------------------
    let subjectName = "";

    if (Array.isArray(teacher.subjects) && teacher.subjects.length > 0) {
      const subjectDoc = await Subject.findOne({
        _id: { $in: teacher.subjects },
        school: classDocFinal.school // 🔒 tenant safety
      }).lean();

      if (subjectDoc) {
        subjectName = subjectDoc.name || subjectDoc.shortName || "";
      }
    }

    log("📚 Resolved teacher subject", {
      rawSubjects: teacher.subjects,
      subjectName
    });

    // ✅ Always use this from now on
    const subject = subjectName;



    const bucket = admin.storage().bucket();
    const { className } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);

    if (!school.sbaMaster?.[classLevelKey]) return res.status(400).json({ message: "Master SBA not initialized. Call download first." });

    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [buffer] = await masterFile.download();
    const workbook = await XlsxPopulate.fromDataAsync(buffer);

    const sheet = workbook.sheet(subject);
    if (!sheet) return res.status(404).json({ message: `Subject sheet '${subject}' not found` });

    const sheetData = [];
    const used = sheet.usedRange();
    if (used) {
      const start = used.startCell();
      const end = used.endCell();
      for (let r = start.rowNumber(); r <= end.rowNumber(); r++) {
        sheetData[r - 1] = sheetData[r - 1] || [];
        for (let c = start.columnNumber(); c <= end.columnNumber(); c++) {
          sheetData[r - 1][c - 1] = sheet.cell(r, c).value();
        }
      }
    }

    res.json({ subject, sheetData });
  } catch (err) {
    console.error("Error fetching subject sheet:", err);
    res.status(500).json({ message: "Server error fetching subject sheet", error: err.message });
  }
};

// 5️⃣ Save teacher's subject sheet
exports.saveSubjectSheet = async (req, res) => {
  let tempFilePath = null;
  try {
    const { teacherId, sheetData } = req.body;
    if (!teacherId || !sheetData) return res.status(400).json({ message: "teacherId and sheetData required" });

    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    if (!teacher.assignedClasses?.length) return res.status(400).json({ message: "No assigned classes for this teacher" });

    const classId = teacher.assignedClasses[0];
    const classDoc = await Class.findById(classId).lean();
    if (!classDoc) return res.status(404).json({ message: "Class not found" });

    const school = await School.findById(classDoc.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // --------------------------------------------------
    // ✅ Resolve teacher subject(s) to STRING (Excel-safe)
    // --------------------------------------------------
    let subjectName = "";

    if (Array.isArray(teacher.subjects) && teacher.subjects.length > 0) {
      const subjectDoc = await Subject.findOne({
        _id: { $in: teacher.subjects },
        school: classDocFinal.school // 🔒 tenant safety
      }).lean();

      if (subjectDoc) {
        subjectName = subjectDoc.name || subjectDoc.shortName || "";
      }
    }

    log("📚 Resolved teacher subject", {
      rawSubjects: teacher.subjects,
      subjectName
    });

    // ✅ Always use this from now on
    const subject = subjectName;


    // ⛔ Hard stop if subject cannot be resolved
    if (!subject) {
      return res.status(400).json({
        message: "Teacher has no subject assigned or subject could not be resolved"
      });
    }


    const bucket = admin.storage().bucket();
    const { className } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);
    if (!school.sbaMaster?.[classLevelKey]) return res.status(400).json({ message: "Master SBA not initialized. Call download first." });

    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [masterBuffer] = await masterFile.download();

    // Load both representations
    const xpMaster = await XlsxPopulate.fromDataAsync(masterBuffer);
    const exceljsWorkbook = new ExcelJS.Workbook();
    await exceljsWorkbook.xlsx.load(masterBuffer);

    // Ensure sheet exists in xpMaster
    let sheet = xpMaster.sheet(subject) || xpMaster.addSheet(subject);
    // Clear usedRange values only (preserve formulas on other sheets)
    const usedRange = sheet.usedRange();
    if (usedRange) usedRange.forEach(cell => cell.clear());

    // Write new sheetData into xpMaster and mirror to exceljs when safe
    for (let r = 0; r < sheetData.length; r++) {
      const rowArray = sheetData[r] || [];
      for (let c = 0; c < rowArray.length; c++) {
        const val = rowArray[c];
        sheet.cell(r + 1, c + 1).value(val);
      }
    }

    // Mirror to ExcelJS but do not overwrite formulas
    const exceljsSheet = exceljsWorkbook.getWorksheet(subject) || exceljsWorkbook.addWorksheet(subject);
    for (let r = 0; r < sheetData.length; r++) {
      const rowArray = sheetData[r] || [];
      const excelRow = exceljsSheet.getRow(r + 1);
      for (let c = 0; c < rowArray.length; c++) {
        const val = rowArray[c];
        const excelCell = excelRow.getCell(c + 1);
        if (!excelCell.formula) {
          excelCell.value = val;
        }
      }
    }

    // Hybrid output: xp -> exceljs
    const xpOut = await xpMaster.outputAsync("nodebuffer");
    await exceljsWorkbook.xlsx.load(xpOut);
    const finalBuffer = await exceljsWorkbook.xlsx.writeBuffer();

    // Save to Firebase
    await bucket.file(school.sbaMaster[classLevelKey].path).save(finalBuffer, {
      metadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    });
    await masterFile.makePublic();

    res.json({ message: "Subject sheet updated successfully", url: school.sbaMaster[classLevelKey].url });

  } catch (err) {
    console.error("Error saving subject sheet (hybrid):", err);
    res.status(500).json({ message: "Server error saving subject sheet", error: err.message });
  }
};

// 6️⃣ Admin download full class workbook
exports.adminDownloadClassWorkbook = async (req, res) => {
  try {
    const { classId } = req.params;
    if (!classId) return res.status(400).json({ message: "classId required" });

    const classDoc = await Class.findById(classId).lean();
    if (!classDoc) return res.status(404).json({ message: "Class not found" });

    const school = await School.findById(classDoc.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    const { className, classDisplayName } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);
    if (!school.sbaMaster?.[classLevelKey])
      return res.status(400).json({ message: "Master SBA not initialized" });

    const bucket = admin.storage().bucket();
    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [buffer] = await masterFile.download();
    const workbook = await XlsxPopulate.fromDataAsync(buffer);

    const filename = `${classDisplayName}_FULL_SBA.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const outBuffer = await workbook.outputAsync("nodebuffer");
    res.send(outBuffer);

  } catch (err) {
    console.error("Error in adminDownloadClassWorkbook:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


exports.uploadReportSheetPDF = [
  upload.single("reportPdf"),
  async (req, res) => {
    let tempFilePath = null;

    try {
      console.log("🚀 [START] uploadReportSheetPDF (SUPER-TURBO)");

      if (!req.file)
        return res.status(400).json({ message: "No REPORT PDF uploaded" });

      const { classId, termId, schoolId } = req.body;

      // 🔒 HARD REQUIRE — NEVER GUESS TERM
      if (!classId || !termId || !schoolId) {
        return res.status(400).json({
          message: "classId, termId, and schoolId are required (no auto-resolution allowed)"
        });
      }

      // ✅ 1️⃣ STRICTLY VALIDATE TERM ID
      // ====================================================
      // Check if termId is a valid MongoDB ObjectId
      if (!mongoose.Types.ObjectId.isValid(termId)) {
        return res.status(400).json({
          message: "Invalid termId format. A valid MongoDB ObjectId is required."
        });
      }

      // Find the Term document to ensure it exists
      const termDoc = await Term.findById(termId).lean();
      if (!termDoc) {
        return res.status(400).json({
          message: "Term not found. The provided termId does not exist in the database."
        });
      }

      // ✅ 2️⃣ NORMALIZE ONCE AND USE AS SINGLE SOURCE OF TRUTH
      // ====================================================
      const termKey = termDoc._id.toString(); // 🔥 Single, canonical term identifier
      console.log("✅ Validated term:", {
        termId: termKey,
        termNumber: termDoc.term,
        academicYear: termDoc.academicYear
      });

      // 🔥 REJECT term numbers or labels explicitly
      // Additional check to prevent numeric or labeled termId
      if (/^[0-9]+$/.test(termId)) {
        return res.status(400).json({
          message: "Numeric term IDs are not accepted. Please use the full MongoDB Term _id.",
          hint: `Received '${termId}'. Use the full ObjectId like '${termKey}'`
        });
      }

      if (termId.toLowerCase().includes('term')) {
        return res.status(400).json({
          message: "Term labels like 'Term 1' are not accepted. Please use the full MongoDB Term _id.",
          hint: `Use the full ObjectId like '${termKey}' instead of '${termId}'`
        });
      }

      // ====================================================
      // REST OF THE CONTROLLER - NO CHANGES TO FIREBASE LOGIC
      // ====================================================

      tempFilePath = req.file.path;
      const bucket = admin.storage().bucket();
      const destination = `reportcards/${schoolId}/${classId}/${termKey}/REPORT.pdf`;

      // Upload full report
      await bucket.upload(tempFilePath, {
        destination,
        metadata: { contentType: "application/pdf" }
      });

      const [pdfUrl] = await bucket.file(destination).getSignedUrl({
        action: "read",
        expires: Date.now() + 365 * 24 * 60 * 60 * 1000
      });

      const classDoc = await Class.findByIdAndUpdate(
        classId,
        { $set: { reportSheetPdfUrl: pdfUrl } },
        { new: true, runValidators: true }
      );
      if (!classDoc) return res.status(404).json({ message: "Class not found" });

      const { classDisplayName } = resolveClassNames(classDoc);

      // Fetch students
      const students = await Student.find({ class: classId })
        .populate("user", "name")
        .populate("parent parentIds")
        .lean();

      if (!students.length)
        return res.status(400).json({ message: "No students found for this class" });

      // Load master PDF
      const pdfBytes = fs.readFileSync(tempFilePath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pageCount = pdfDoc.getPageCount();

      console.log(`📄 REPORT.pdf pages: ${pageCount}`);
      console.log(`👩‍🎓 Students in class: ${students.length}`);

      // ⚠️ SAFETY WARNING (does NOT stop upload)
      if (pageCount !== students.length) {
        console.warn("⚠️ PAGE/STUDENT COUNT MISMATCH", {
          pageCount,
          studentCount: students.length
        });
      }

      // Load school info
      const schoolInfo = await SchoolInfo.findOne({ school: schoolId }).lean();

      const fetchImage = async (url) => {
        if (!url) return null;
        try {
          const resp = await axios.get(url, { responseType: "arraybuffer" });
          return Buffer.from(resp.data);
        } catch (e) {
          console.warn("Image fetch failed:", e.message || e);
          return null;
        }
      };

      const [crestBuf, sigBuf] = await Promise.all([
        fetchImage(schoolInfo?.logo),
        fetchImage(schoolInfo?.headTeacherSignature)
      ]);

      let crestImage = null;
      let signatureImage = null;

      if (crestBuf) {
        crestImage =
          crestBuf[0] === 0x89
            ? await pdfDoc.embedPng(crestBuf)
            : await pdfDoc.embedJpg(crestBuf);
      }

      if (sigBuf) {
        signatureImage =
          sigBuf[0] === 0x89
            ? await pdfDoc.embedPng(sigBuf)
            : await pdfDoc.embedJpg(sigBuf);
      }

      const { findTextPosition } = require("../utils/pdfTextLocator");
      const rawPdfBuffer = await pdfDoc.save();

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const page = pdfDoc.getPage(pageIndex);
        const { width, height } = page.getSize();

        if (crestImage) {
          page.drawImage(crestImage, {
            x: 85,
            y: height - 160,   // ⬇ lowered a bit
            width: 65,
            height: 65
          });

        }


        const sigPos = await findTextPosition(rawPdfBuffer, pageIndex, "HEADTEACHER");
        if (sigPos && signatureImage) {
          page.drawImage(signatureImage, {
            x: sigPos.x + 180,
            y: sigPos.y - 10,
            width: 150,
            height: 40
          });
        }
      }

      const updatedPdfBytes = await pdfDoc.save();
      const finalDoc = await PDFDocument.load(updatedPdfBytes);

      const uploadedReports = {};
      const notifications = [];

      function collectRecipientIds(student) {
        const set = new Set();
        if (student.user?._id) set.add(String(student.user._id));
        if (student.parent) {
          if (typeof student.parent === "string") set.add(student.parent);
          else if (student.parent._id) set.add(String(student.parent._id));
        }
        if (Array.isArray(student.parentIds)) {
          student.parentIds.forEach(p => {
            if (!p) return;
            if (typeof p === "string") set.add(p);
            else if (p._id) set.add(String(p._id));
          });
        }
        return [...set];
      }

      for (let i = 0; i < students.length; i++) {
        const student = students[i];

        try {
          const studentPdf = await PDFDocument.create();
          const [copiedPage] = await studentPdf.copyPages(finalDoc, [i]);
          studentPdf.addPage(copiedPage);

          const studentBytes = await studentPdf.save();
          const studentDest = `reportcards/${schoolId}/${classId}/${termKey}/${student._id}.pdf`;
          const file = bucket.file(studentDest);

          await file.save(studentBytes, {
            metadata: { contentType: "application/pdf" }
          });

          const [studentUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000
          });

          uploadedReports[student._id] = studentUrl;

          // ✅ 3️⃣ STORE STUDENT REPORT URLS USING ONLY termKey
          // ====================================================
          // 🔥 Store report cards using ONLY the termKey (ObjectId string)
          // 🚫 Never store using: "1", "2", "Term 1", "Term 2", academic years, dates, or derived labels
          await Student.findByIdAndUpdate(student._id, {
            $set: {
              [`reportCards.${termKey}`]: studentUrl,
              // Optionally store metadata separately if needed (not as key)
              reportCardMetadata: {
                [termKey]: {
                  termNumber: termDoc.term,
                  academicYear: termDoc.academicYear,
                  uploadedAt: new Date(),
                  uploadedBy: req.user?._id
                }
              }
            }
          });

          notifications.push({
            title: "New Report Card Available",
            message: `Your Term ${termDoc.term || 'Unknown'} report card has been uploaded.`,
            category: "report",
            audience: "student",
            class: classId,
            studentId: student._id,
            termId: termKey, // Store the termKey (ObjectId string)
            termNumber: termDoc.term, // Store term number separately for display
            academicYear: termDoc.academicYear,
            fileUrl: studentUrl,
            school: schoolId,
            sender: req.user?._id,
            recipientUsers: collectRecipientIds(student)
          });
        } catch (err) {
          console.error(`Failed processing student ${student._id}:`, err);
        }
      }

      if (notifications.length) {
        try {
          await Notification.insertMany(notifications);
        } catch (e) {
          console.warn("Failed to batch insert notifications:", e.message || e);
        }
      }

      // ✅ 4️⃣ UPDATE TERM DOCUMENT USING termKey
      // ====================================================
      // Firebase storage paths remain unchanged and consistent
      await Term.findByIdAndUpdate(termKey, {
        $set: { [`reportSheets.${classId}`]: pdfUrl }
      });

      res.json({
        message: "SUPER-TURBO upload complete",
        class: classDisplayName,
        term: {
          id: termKey,
          number: termDoc.term,
          academicYear: termDoc.academicYear
        },
        totalStudents: students.length,
        uploadedCount: Object.keys(uploadedReports).length,
        classPdfUrl: pdfUrl,
        storagePath: `reportcards/${schoolId}/${classId}/${termKey}/`,
        perStudent: uploadedReports
      });
    } catch (err) {
      console.error("Error in SUPER-TURBO upload:", err);
      res.status(500).json({
        message: "Failed to process report sheets",
        error: err.message
      });
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }
];


// ==================== UPDATED ROUTE ====================
exports.getMyReportSheet = async (req, res) => {
  try {
    const { studentId, termId } = req.params;
    const { childId } = req.query;
    const requester = req.user;

    // 🔑 NORMALIZE TERM ID (MUST MATCH UPLOAD)
    const termKey = String(termId);

    console.log("🚀 [START] getMyReportSheet", {
      studentId,
      termId: termKey,
      childId,
      role: requester?.role,
      requesterId: requester?._id,
    });

    let targetStudent;

    // 🎓 STUDENT ACCESS
    if (requester.role === "student") {
      targetStudent = await Student.findOne({ user: requester._id })
        .populate("class", "name displayName stream")
        .populate("user", "name")
        .lean();

      if (!targetStudent) {
        return res.status(404).json({ message: "Student not found." });
      }
    }

    // 👪 PARENT ACCESS
    else if (requester.role === "parent") {
      const targetId = childId || studentId;
      if (!targetId) {
        return res.status(400).json({ message: "childId or studentId required" });
      }

      targetStudent = await Student.findOne({
        _id: targetId,
        $or: [
          { parent: requester._id },
          { parentIds: { $in: [requester._id] } },
        ],
      })
        .populate("class", "name displayName stream")
        .populate("user", "name")
        .lean();

      if (!targetStudent) {
        return res.status(403).json({ message: "Unauthorized childId" });
      }
    }

    // 🚫 BLOCK ALL OTHER ROLES
    else {
      return res.status(403).json({
        message: "Only students or linked parents can view report cards.",
      });
    }

    // --------------------------
    // VALIDATION
    // --------------------------
    if (!targetStudent || !targetStudent.class) {
      return res.status(400).json({
        message: "Student not assigned to a class.",
      });
    }

    const studentDisplayName =
      targetStudent.user?.name || targetStudent.name || "Student";

    const safeName =
      studentDisplayName.replace(/\s+/g, "_") + "_Report.pdf";

    // --------------------------
    // FETCH STUDENT-SPECIFIC PDF
    // --------------------------
    const pdfUrl =
      targetStudent.reportCards?.[termKey] ||
      targetStudent.reportCards?.get?.(termKey);

    // --------------------------
    // CASE 1 → INDIVIDUAL REPORT EXISTS
    // --------------------------
    if (pdfUrl) {
      console.log("✅ Serving individual report", {
        studentId: targetStudent._id,
        termId: termKey,
      });

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeName}"`
      );
      return res.redirect(302, pdfUrl);
    }

    // --------------------------
    // ❌ NO FALLBACK — HARD STOP
    // --------------------------
    console.warn("⚠️ Missing individual report", {
      studentId: targetStudent._id,
      termId: termKey,
      availableTerms: Object.keys(targetStudent.reportCards || {}),
    });

    return res.status(404).json({
      message:
        "Your report card is not ready yet. Please check with your school.",
    });
  } catch (err) {
    console.error("💥 getMyReportSheet error:", err);
    return res.status(500).json({
      message: "Failed to fetch report card.",
      error: err.message,
    });
  }
};



// 🚀 GET true overall subject + class average (based on total marks of all subjects)
exports.getOverallSubjectAverage = async (req, res) => {
  try {
    const { classId } = req.params;
    console.log("🚀 [START] getOverallSubjectAverage for class:", classId);

    if (!classId) return res.status(400).json({ message: "classId is required" });

    const classDoc = await Class.findById(classId).lean();
    if (!classDoc) return res.status(404).json({ message: "Class not found" });

    const school = await School.findById(classDoc.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // ✅ Use resolveClassNames helper
    const { className, classDisplayName } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);

    if (!school.sbaMaster?.[classLevelKey]) {
      return res.status(400).json({ message: "Master SBA not initialized for this class" });
    }

    // 🎓 Load master SBA workbook
    const bucket = admin.storage().bucket();
    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [buffer] = await masterFile.download();
    const workbook = await XlsxPopulate.fromDataAsync(buffer);

    // 🧠 Detect valid subject sheets
    const excludedKeywords = [
      "POSITION", "SUMMARY", "REMARK", "SBA", "REPORT", "HOME", "NAME", "SHEET"
    ];
    const allSheetNames = workbook.sheets().map(s => s.name());
    const subjectSheets = allSheetNames.filter(
      name => !excludedKeywords.some(ex => name.toUpperCase().includes(ex))
    );

    console.log(`📚 Detected Subject Sheets: ${subjectSheets.join(", ")}`);

    const subjectResults = [];
    let totalAllSubjects = 0; // sum of all subject totals
    let totalStudentCount = 0; // average across all subjects

    // 🔁 Loop through all subject sheets
    for (const sheetName of subjectSheets) {
      const sheet = workbook.sheet(sheetName);
      if (!sheet) continue;

      console.log(`\n📖 Processing ${sheetName}...`);

      let subjectTotal = 0;
      let studentCount = 0;

      // Rows 14–30 = students
      for (let row = 14; row <= 30; row++) {
        try {
          const c = extractNumericValue(sheet.cell(`C${row}`)) || 0;
          const d = extractNumericValue(sheet.cell(`D${row}`)) || 0;
          const e = extractNumericValue(sheet.cell(`E${row}`)) || 0;
          const f = extractNumericValue(sheet.cell(`F${row}`)) || 0;
          const totalClassScore = c + d + e + f;

          const scaledClassScore = (totalClassScore / 60) * 50;
          const examScore = extractNumericValue(sheet.cell(`I${row}`)) || 0;
          const scaledExamScore = examScore * 0.5;
          const finalScore = scaledClassScore + scaledExamScore;

          if (totalClassScore > 0 || examScore > 0) {
            subjectTotal += finalScore;
            studentCount++;
          }
        } catch {
          continue;
        }
      }

      if (studentCount > 0) {
        const subjectAverage = parseFloat((subjectTotal / studentCount).toFixed(2));
        totalAllSubjects += subjectTotal;
        totalStudentCount += studentCount;

        subjectResults.push({
          subject: sheetName,
          average: subjectAverage,
          totalMarks: parseFloat(subjectTotal.toFixed(2)),
          studentCount
        });

        console.log(`📊 ${sheetName} → Total: ${subjectTotal.toFixed(2)} | Avg: ${subjectAverage}%`);
      }
    }

    // 🎯 Compute overall class performance
    if (subjectResults.length > 0) {
      const totalSubjectCount = subjectResults.length;
      const averageOfSubjectAverages =
        subjectResults.reduce((sum, s) => sum + s.average, 0) / totalSubjectCount;

      console.log(`\n🎯 FINAL CLASS PERFORMANCE SUMMARY`);
      console.log(`   → Subjects: ${totalSubjectCount}`);
      console.log(`   → Combined total marks: ${totalAllSubjects.toFixed(2)}`);
      console.log(`   → Average of subject averages: ${averageOfSubjectAverages.toFixed(2)}%`);

      return res.json({
        message: "✅ True overall subject and class average computed successfully",
        data: {
          classId,
          className: classDisplayName, // ✅ Use classDisplayName for frontend
          totalSubjects: totalSubjectCount,
          combinedSubjectTotal: parseFloat(totalAllSubjects.toFixed(2)),
          classAverage: parseFloat(averageOfSubjectAverages.toFixed(2)),
          subjectAverages: subjectResults,
          timestamp: new Date().toISOString()
        }
      });
    }

    return res.status(404).json({
      message: "No valid student marks found in any subject sheets",
      data: { classId, className: classDisplayName } // ✅ Use classDisplayName for frontend
    });
  } catch (err) {
    console.error("❌ Error computing true class average:", err);
    res.status(500).json({
      message: "Failed to compute true class average",
      error: err.message
    });
  }
};

// 🧩 Extract numeric or computed formula value safely
function extractNumericValue(cell) {
  try {
    const raw = cell.value();
    if (typeof raw === "number") return raw;

    if (typeof raw === "object" && raw !== null) {
      if (typeof raw.result === "number") return raw.result;
      if (raw.formula && raw.result !== undefined) {
        const numeric = parseFloat(String(raw.result));
        if (!isNaN(numeric)) return numeric;
      }
    }

    if (typeof raw === "string") {
      const numeric = parseFloat(raw.replace(/[^\d.-]/g, ""));
      if (!isNaN(numeric)) return numeric;
    }

    return NaN;
  } catch {
    return NaN;
  }
}

// 🚀 GET Class Averages for Performance Chart
exports.getClassAveragesForChart = async (req, res) => {
  try {
    console.log("🚀 [START] getClassAveragesForChart");

    // ✅ Support both query and logged-in user's school
    let schoolId = req.query.schoolId || req.user?.school?._id || req.user?.school?.id || req.user?.school;
    if (!schoolId) {
      return res.status(400).json({ message: "schoolId is required" });
    }

    // ✅ Ensure it's a proper string (ObjectId-friendly)
    if (typeof schoolId === "object" && schoolId._id) schoolId = schoolId._id.toString();

    // 🏫 Fetch school
    const school = await School.findById(schoolId).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // 📘 Fetch all classes for that school
    const classes = await Class.find({ school: schoolId }).lean();
    if (!classes.length) return res.status(404).json({ message: "No classes found for this school" });

    const classAverages = [];

    // 🧮 Iterate each class and calculate averages
    for (const classDoc of classes) {
      try {
        // ✅ Use resolveClassNames helper
        const { className, classDisplayName } = resolveClassNames(classDoc);
        const classLevelKey = getClassLevelKey(className);

        if (!school.sbaMaster?.[classLevelKey]) {
          console.log(`⚠️ No SBA master workbook for ${classDisplayName}, skipping`);
          continue;
        }

        // 🪣 Load the class SBA workbook from Firebase Storage
        const bucket = admin.storage().bucket();
        const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
        const [buffer] = await masterFile.download();
        const workbook = await XlsxPopulate.fromDataAsync(buffer);

        // 📑 Identify subject sheets (exclude summary/position sheets)
        const excludedKeywords = ["POSITION", "SUMMARY", "REMARK", "SBA", "REPORT", "HOME", "NAME", "SHEET"];
        const allSheetNames = workbook.sheets().map((s) => s.name());
        const subjectSheets = allSheetNames.filter(
          (name) => !excludedKeywords.some((ex) => name.toUpperCase().includes(ex))
        );

        let totalSubjectAverages = 0;
        let validSubjects = 0;

        // 🔢 For each subject sheet
        for (const sheetName of subjectSheets) {
          const sheet = workbook.sheet(sheetName);
          if (!sheet) continue;

          let subjectTotalMarks = 0;
          let studentCount = 0;

          // Loop over student rows (adjust range as needed)
          for (let row = 14; row <= 30; row++) {
            try {
              const c = extractNumericValue(sheet.cell(`C${row}`)) || 0;
              const d = extractNumericValue(sheet.cell(`D${row}`)) || 0;
              const e = extractNumericValue(sheet.cell(`E${row}`)) || 0;
              const f = extractNumericValue(sheet.cell(`F${row}`)) || 0;
              const totalClassScore = c + d + e + f;

              const scaledClassScore = (totalClassScore / 60) * 50; // CA is 50%
              const examScore = extractNumericValue(sheet.cell(`I${row}`)) || 0;
              const scaledExamScore = examScore * 0.5; // Exam is 50%
              const finalScore = scaledClassScore + scaledExamScore;

              if (totalClassScore > 0 || examScore > 0) {
                subjectTotalMarks += finalScore;
                studentCount++;
              }
            } catch {
              continue;
            }
          }

          if (studentCount > 0) {
            const subjectAverage = subjectTotalMarks / studentCount;
            totalSubjectAverages += subjectAverage;
            validSubjects++;
          }
        }

        if (validSubjects > 0) {
          const overallClassAverage = parseFloat((totalSubjectAverages / validSubjects).toFixed(2));

          classAverages.push({
            classId: classDoc._id,
            className: classDisplayName, // ✅ Use classDisplayName for charts
            average: overallClassAverage,
            subjectCount: validSubjects,
            studentCount: classDoc.students?.length || 0,
          });

          console.log(`📊 ${classDisplayName} → ${overallClassAverage}% across ${validSubjects} subjects`);
        }
      } catch (err) {
        console.error(`❌ Error processing class ${classDisplayName}:`, err.message);
        continue;
      }
    }

    // 🧠 Sort by average (descending)
    classAverages.sort((a, b) => b.average - a.average);

    res.json({
      message: "Class averages fetched successfully",
      data: classAverages,
      bestClass: classAverages[0] || null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Error in getClassAveragesForChart:", err);
    res.status(500).json({
      message: "Failed to fetch class averages",
      error: err.message,
    });
  }
};