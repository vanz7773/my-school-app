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

// JHS check
function isJhsClass(className = "") {
  return /\bbasic\s*7\b|\bbasic\s*8\b|\bbasic\s*9\b/i.test(className);
}

// BASIC 1–6 check
function isBasic1to6(className = "") {
  return /\bbasic\s*[1-6]\b/i.test(className);
}

// ✅ NEW: Nursery & KG checks
function isNurseryClass(className = "") {
  return /\bnursery\s*[1-2]\b/i.test(className);
}

function isKgClass(className = "") {
  return /\bkg\s*[1-2]\b/i.test(className);
}

/**
 * Determines SBA master key (e.g. Basic_1, Basic_2, KG_1, Nursery_1, etc.)
 */
function getClassLevelKey(className) {
  if (!className) return null;
  const cleaned = className.trim().replace(/\s+/g, "_");

  if (isJhsClass(className)) return cleaned;
  if (isBasic1to6(className)) return cleaned;
  if (isNurseryClass(className)) return cleaned;
  if (isKgClass(className)) return cleaned;

  // fallback — allow any other class names as-is
  return cleaned;
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
  try {
    console.log("🚀 Hybrid Download class template started");
    const { teacherId } = req.params;
    if (!teacherId)
      return res.status(400).json({ message: "teacherId is required" });

    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    const userId = teacher.user;

    // Locate class
    const classDoc = await Class.findOne({ classTeacher: userId }).lean();
    let targetClassId = classDoc?._id;
    let isClassTeacher = !!classDoc;

    if (!targetClassId && teacher.assignedClasses?.length)
      targetClassId = teacher.assignedClasses[0];
    if (!targetClassId)
      return res.status(400).json({ message: "No class found for this teacher" });

    const classDocFinal = classDoc || (await Class.findById(targetClassId).lean());
    const students = await Student.find({ class: targetClassId })
      .populate("user", "name")
      .lean();

    if (!students.length)
      return res.status(400).json({ message: "No students found for this class" });

    const school = await School.findById(classDocFinal.school).lean();
    if (!school) return res.status(404).json({ message: "School not found" });

    // Term / Academic Year info
    let classTeacherName = "N/A";
    if (classDocFinal.classTeacher) {
      const ct = await User.findById(classDocFinal.classTeacher).lean();
      classTeacherName = ct?.name || "N/A";
    }

    let termName = "N/A",
      academicYear = "N/A";

    let resolvedTermId = null; // ✅ IMPORTANT: expose resolved termId

try {
  let termDoc = null;

  // 🔥 1️⃣ FIRST PRIORITY: termId from frontend filter
  if (req.query.termId) {
    termDoc = await Term.findOne({
      _id: req.query.termId,
      school: classDocFinal.school,
    }).lean();
  }

  // 2️⃣ Use class term if available
  if (!termDoc && classDocFinal.termId) {
    termDoc = await Term.findById(classDocFinal.termId).lean();
  }

  // 3️⃣ Fallback to active term by date
  if (!termDoc) {
    const today = new Date();
    termDoc = await Term.findOne({
      school: classDocFinal.school,
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).lean();
  }

  // 4️⃣ Final fallback: most recent term
  if (!termDoc) {
    termDoc = await Term.findOne({ school: classDocFinal.school })
      .sort({ startDate: -1 })
      .lean();
  }

  // ✅ Apply resolved term
  if (termDoc) {
    termName = termDoc.term || "N/A";
    academicYear = termDoc.academicYear || "N/A";
    resolvedTermId = termDoc._id; // ✅ THIS FIXES ATTENDANCE
  }

} catch (e) {
  console.error("❌ Error resolving term:", e);
}


    const bucket = admin.storage().bucket();
    const { className, classDisplayName } = resolveClassNames(classDocFinal);
    const classLevelKey = getClassLevelKey(className); // Use className for logic
    const subject = teacher.subject;

    // Ensure school master exists
    if (!school.sbaMaster?.[classLevelKey]) {
      console.log("📄 School master missing, cloning global template");
      const globalTemplate = await SbaTemplate.findOne({ key: classLevelKey }).lean();
      if (!globalTemplate) {
        return res.status(404).json({
          message: "SBA template has not been uploaded yet. Please contact the administrator."
        });
      }

      let buffer;
      if (globalTemplate.path) {
        [buffer] = await bucket.file(globalTemplate.path).download();
      } else if (globalTemplate.url) {
        const axios = require("axios");
        const resp = await axios.get(globalTemplate.url, { responseType: "arraybuffer" });
        buffer = resp.data;
      } else {
        return res.status(500).json({ message: "Global template missing file reference" });
      }

      const schoolPath = `templates/${school._id}/${classLevelKey}_master.xlsx`;
      tempFilePath = path.join("uploads", `clone_${school._id}_${Date.now()}.xlsx`);
      fs.writeFileSync(tempFilePath, buffer);

      await bucket.upload(tempFilePath, {
        destination: schoolPath,
        metadata: {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
      await bucket.file(schoolPath).makePublic();
      fs.unlinkSync(tempFilePath);

      await School.findByIdAndUpdate(school._id, {
        $set: {
          [`sbaMaster.${classLevelKey}`]: {
            path: schoolPath,
            url: `https://storage.googleapis.com/${bucket.name}/${schoolPath}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      });
      school.sbaMaster = school.sbaMaster || {};
      school.sbaMaster[classLevelKey] = {
        path: schoolPath,
        url: `https://storage.googleapis.com/${bucket.name}/${schoolPath}`,
      };
      console.log("✅ School master initialized");
    }

    // Download master file (direct from Firebase)
    const masterFile = bucket.file(school.sbaMaster[classLevelKey].path);
    const [masterBuffer] = await masterFile.download();

    // 🧠 Load workbook using XlsxPopulate (preserves hyperlinks + formulas)
    const xpWorkbook = await XlsxPopulate.fromDataAsync(masterBuffer);

    // Fill sheets using XlsxPopulate - use classDisplayName for display
    const homeSheet = xpWorkbook.sheet("HOME") || xpWorkbook.sheet("Home");
    if (homeSheet) {
      homeSheet.cell("B9").value(school.name || "N/A");
      homeSheet.cell("B12").value(classTeacherName || "N/A");
      homeSheet.cell("K9").value(classDisplayName);
      homeSheet.cell("I18").value(termName || "N/A");
      homeSheet.cell("K18").value(students.length || 0);
    }

    const home2Sheet = xpWorkbook.sheet("HOME2") || xpWorkbook.sheet("Home2");
    if (home2Sheet) {
      home2Sheet.cell("F8").value(school.name || "N/A");
      home2Sheet.cell("P8").value(classDisplayName);
      home2Sheet.cell("P11").value(termName || "N/A");
      home2Sheet.cell("Q14").value(academicYear || "N/A");
    }

    const namesSheet = xpWorkbook.sheet("NAMES");
    if (namesSheet) {
      const startRow = 9;
      students.forEach((stu, i) => {
        namesSheet.cell(`E${startRow + i}`).value(stu.user?.name || "N/A");
      });
    }

    // ===============================
    // 📊 FIRST: Let's examine the template structure
    // ===============================
    console.log("🔍 === TEMPLATE ANALYSIS ===");
    const allSheets = xpWorkbook.sheets();
    console.log(`Total sheets: ${allSheets.length}`);
    allSheets.forEach((sheet, index) => {
      console.log(`Sheet ${index + 1}: "${sheet.name()}"`);
      
      // Check if this sheet contains student names
      const usedRange = sheet.usedRange();
      if (usedRange) {
        const start = usedRange.startCell();
        const end = usedRange.endCell();
        console.log(`   Range: ${start.address()} to ${end.address()}`);
        
        // Look for "Attendance" headers in first 50 rows
        for (let r = 1; r <= Math.min(50, end.rowNumber()); r++) {
          for (let c = 1; c <= Math.min(10, end.columnNumber()); c++) {
            const cell = sheet.cell(r, c);
            const value = cell.value();
            if (value && value.toString().toLowerCase().includes("attendance")) {
              console.log(`   Found "Attendance" at ${cell.address()}: "${value}"`);
            }
            if (value && value.toString().toLowerCase().includes("total")) {
              console.log(`   Found "Total" at ${cell.address()}: "${value}"`);
            }
          }
        }
      }
    });
    console.log("🔍 === END TEMPLATE ANALYSIS ===");

    // ===============================
    // 📊 Inject Attendance per Student (CORRECTED POSITION)
    // ===============================
    if (resolvedTermId) {
      const reportSheet = xpWorkbook.sheet("REPORT");
      
      if (!reportSheet) {
        console.warn("⚠️ REPORT sheet not found");
      } else {
        console.log(`✅ Found REPORT sheet. Writing attendance...`);
        
        // Based on template analysis: "ATTENDANCE:" is at B30
        // Let's find where to write the actual attendance values
        
        console.log("🔍 Examining cells around B30:");
        for (let col = 1; col <= 6; col++) {
          const colLetter = String.fromCharCode(64 + col); // A, B, C...
          const cellAddr = `${colLetter}30`;
          const cellValue = reportSheet.cell(cellAddr).value();
          console.log(`   ${cellAddr}: "${cellValue}"`);
        }
        
        // Check row pattern (40-row intervals)
        console.log("🔍 Checking attendance row pattern:");
        const attendanceRows = [30, 70, 110, 150, 190, 230, 270, 310, 350, 390];
        
        for (const row of attendanceRows) {
          const headerCell = reportSheet.cell(`B${row}`).value();
          if (headerCell && headerCell.toString().includes("ATTENDANCE")) {
            console.log(`   Found "ATTENDANCE" at B${row}`);
            console.log(`   Cell D${row} current value: "${reportSheet.cell(`D${row}`).value()}"`);
          }
        }
        
        console.log(`📊 Writing attendance for ${students.length} students`);
        
        let firstAttendanceRow = 30;
let rowInterval = 40;
let attendanceColumn = "D";

// 📘 BASIC 1 – BASIC 6
if (isBasic1to6(className)) {
  firstAttendanceRow = 29;
  rowInterval = 39;
}

// 🧸 KG 1, KG 2, NURSERY 1, NURSERY 2
if (isKgClass(className) || isNurseryClass(className)) {
  firstAttendanceRow = 24;
  rowInterval = 34;
}

        
        for (let i = 0; i < students.length; i++) {
          const student = students[i];
          
          const totalAttendance = await getStudentTermAttendance(
            student._id,
            resolvedTermId,              // ✅ FIXED
            classDocFinal.school
          );
          
          const targetRow = firstAttendanceRow + (i * rowInterval);
          const targetCell = `${attendanceColumn}${targetRow}`;
          
          console.log(`📝 Student ${i + 1}: ${student.user?.name || student._id}`);
          console.log(`   Writing to ${targetCell}: ${totalAttendance} days`);
          
          reportSheet.cell(targetCell).value(totalAttendance);
          reportSheet.cell(targetCell).style("numberFormat", "0");
          
          const nameCellC = reportSheet.cell(`C${targetRow}`).value();
          const nameCellE = reportSheet.cell(`E${targetRow}`).value();
          console.log(`   Nearby cells: C${targetRow}="${nameCellC}", E${targetRow}="${nameCellE}"`);
        }
        
        // TOTAL ATTENDANCE (optional summary)
        console.log("🔍 Looking for TOTAL ATTENDANCE summary cell...");
        for (let r = 1; r <= 50; r++) {
          for (let c = 1; c <= 10; c++) {
            const colLetter = String.fromCharCode(64 + c);
            const cell = reportSheet.cell(`${colLetter}${r}`);
            const value = cell.value();
            
            if (value && value.toString().toLowerCase().includes("total attendance")) {
              console.log(`✅ Found TOTAL ATTENDANCE at ${colLetter}${r}: "${value}"`);
              
              let totalAllAttendance = 0;
              for (let i = 0; i < students.length; i++) {
                totalAllAttendance += await getStudentTermAttendance(
                  students[i]._id,
                  resolvedTermId,          // ✅ FIXED
                  classDocFinal.school
                );
              }
              
              const totalCell = reportSheet.cell(
                `${String.fromCharCode(64 + c + 1)}${r}`
              );
              totalCell.value(totalAllAttendance);
              totalCell.style("numberFormat", "0");
              
              console.log(`   Written total attendance: ${totalAllAttendance}`);
            }
          }
        }
        
        console.log("✅ Attendance writing completed!");
      }
    } else {
      console.log("⚠️ No resolvedTermId found, skipping attendance injection");
    }

    // 🧹 Remove unused sheets if not class teacher
    if (!isClassTeacher) {
      const allSheets = xpWorkbook.sheets();
      const normalizedSubject = (subject || "").trim().toUpperCase();

      // 1️⃣ Build keep list
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

      console.log("🎯 Keeping sheets:", keepList);

      // 2️⃣ Find fallback active sheet
      const fallbackSheet =
        allSheets.find((s) => keepList.includes(s.name()) && !s.hidden()) ||
        allSheets.find((s) => !s.hidden());

      if (fallbackSheet) xpWorkbook.activeSheet(fallbackSheet.name());

      // 3️⃣ Delete everything else safely
      allSheets.forEach((s) => {
        const sheetName = s.name();
        if (!keepList.includes(sheetName)) {
          if (xpWorkbook.activeSheet().name() === sheetName) {
            const nextVisible = xpWorkbook
              .sheets()
              .find((x) => keepList.includes(x.name()) && !x.hidden());
            if (nextVisible) xpWorkbook.activeSheet(nextVisible.name());
          }
          xpWorkbook.deleteSheet(sheetName);
          console.log(`🗑️ Deleted sheet: ${sheetName}`);
        }
      });

      // 4️⃣ Handle missing subject sheet gracefully
      if (!xpWorkbook.sheet(subject)) {
        console.warn(`⚠️ Subject sheet "${subject}" not found in template`);
      }

      console.log("📝 Pruned workbook for subject teacher (only subject + core sheets kept)");
    }

    // ✨ Output final file directly (no ExcelJS rewrite!)
    const finalBuffer = await xpWorkbook.outputAsync("nodebuffer");

    const filename = isClassTeacher
      ? `${classDisplayName}_FULL_SBA.xlsx`
      : `${subject}_SBA.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(finalBuffer);

    console.log("✅ Download complete — formulas + hyperlinks preserved");
  } catch (err) {
    console.error("❌ Error in downloadClassTemplate:", err);
    res.status(500).json({
      message: "Server error downloading class template",
      error: err.message,
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
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
    const subject = teacher.subject;

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

    const bucket = admin.storage().bucket();
    const { className } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);
    const subject = teacher.subject;
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

    const bucket = admin.storage().bucket();
    const { className } = resolveClassNames(classDoc);
    const classLevelKey = getClassLevelKey(className);
    const subject = teacher.subject;
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
            x: width - 160,
            y: height - 170,
            width: 100,
            height: 100
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