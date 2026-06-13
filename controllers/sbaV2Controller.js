const fs = require("fs");
const multer = require("multer");
const admin = require("firebase-admin");
const mongoose = require("mongoose");
const { PDFDocument } = require("pdf-lib");
const { Expo } = require("expo-server-sdk");
const SbaRecord = require("../models/SbaRecord");
const Student = require("../models/Student");
const Class = require("../models/Class");
const User = require("../models/User");
const Term = require("../models/term");
const Notification = require("../models/Notification");
const PushToken = require("../models/PushToken");

const upload = multer({ dest: "uploads/" });
const expo = new Expo();

// Calculate total and grade automatically based on class level
const calculateGrade = (total, className = "") => {
  const upperName = className.toUpperCase();
  
  // Nursery / KG Grading
  if (upperName.includes("NURSERY") || upperName.includes("KG") || upperName.includes("CRECHE")) {
    if (total >= 70) return "Gold (G)";
    if (total >= 40) return "Silver (S)";
    return "Bronze (B)";
  }

  // Basic School (BS1 - BS9) Grading
  if (total >= 80) return "Advance (A)";
  if (total >= 75) return "Proficient (P)";
  if (total >= 70) return "Approaching Proficiency (AP)";
  if (total >= 65) return "Developing (D)";
  return "Beginning (B)";
};

const toIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value._id || value.id || value);
};

const formatTermLabel = (termValue) => {
  const value = String(termValue || "").trim();
  if (!value) return "Term Unknown";
  return /^term\b/i.test(value) ? value : `Term ${value}`;
};

const addRecordAlias = (map, id, record) => {
  const key = toIdString(id);
  if (key && !map[key]) map[key] = record;
};

const addCommentAlias = (map, id, record) => {
  const key = toIdString(id);
  if (!key) return;

  const current = map[key] || {};
  const merged = {
    conduct: current.conduct || record.conduct || "",
    interest: current.interest || record.interest || "",
    teacherRemarks: current.teacherRemarks || record.teacherRemarks || "",
    nextTermBegins: current.nextTermBegins || record.nextTermBegins || "",
    promotedTo: current.promotedTo || record.promotedTo || "",
  };

  map[key] = merged;
};

const parseStringArray = (value) => {
  if (!value) return [];
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : [];
  } catch (error) {
    console.warn("Invalid string array payload ignored:", error.message || error);
    return [];
  }
};

const getParentIds = (student) => {
  const set = new Set();
  if (student.parent) {
    if (typeof student.parent === "string") set.add(student.parent);
    else if (student.parent._id) set.add(String(student.parent._id));
  }
  if (Array.isArray(student.parentIds)) {
    student.parentIds.forEach((parent) => {
      if (!parent) return;
      if (typeof parent === "string") set.add(parent);
      else if (parent._id) set.add(String(parent._id));
    });
  }
  return [...set];
};

const applyStudentOrder = (students, studentOrder) => {
  if (!Array.isArray(studentOrder) || studentOrder.length === 0) {
    students.sort((a, b) => {
      const aName = a.user?.name || a.name || "";
      const bName = b.user?.name || b.name || "";
      return aName.localeCompare(bName);
    });
    return;
  }

  const orderById = new Map(studentOrder.map((id, index) => [id, index]));
  const getStudentOrderIndex = (student) => {
    const possibleIds = [
      student._id,
      student.id,
      student.user?._id,
      student.user?.id,
    ].map(item => String(item || "")).filter(Boolean);

    for (const id of possibleIds) {
      if (orderById.has(id)) return orderById.get(id);
    }
    return Number.MAX_SAFE_INTEGER;
  };

  students.sort((a, b) => getStudentOrderIndex(a) - getStudentOrderIndex(b));
};

async function sendPush(userIds, title, body) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false,
  }).lean();

  const validTokens = tokens
    .map(tokenDoc => tokenDoc.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (validTokens.length === 0) return;

  const messages = validTokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data: { type: "report-card" },
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      console.error("Push error:", error);
    }
  }
}

/**
 * Get SBA Marks for a specific class, subject, and term.
 * Returns the saved marks and combines them with any students currently enrolled who don't have marks yet.
 */
exports.getSubjectMarks = async (req, res) => {
  try {
    const { schoolId, classId, termId, subjectId } = req.query;

    if (!schoolId || !classId || !termId || !subjectId) {
      return res.status(400).json({ message: "Missing required parameters: schoolId, classId, termId, subjectId" });
    }

    // 1. Find all students in the class using the Student collection
    const studentDocs = await Student.find({ class: classId })
      .populate("user", "name profilePicture")
      .lean();

    const students = studentDocs.filter(s => s.user); // Ensure user is not null
    
    console.log(`Found ${students.length} students in Student collection for class ${classId}`);

    // 2. Find existing marks
    const sbaRecord = await SbaRecord.findOne({
      school: schoolId,
      class: classId,
      term: termId,
      subject: subjectId,
    }).sort({ updatedAt: -1 }).lean();
    const termSbaRecords = await SbaRecord.find({
      school: schoolId,
      class: classId,
      term: termId,
    }).select("records updatedAt").sort({ updatedAt: -1 }).lean();

    // 3. Map students to their marks, generating an empty mark object if none exists
    const recordsMap = {};
    if (sbaRecord && sbaRecord.records) {
      sbaRecord.records.forEach((record) => {
        addRecordAlias(recordsMap, record.student, record);
        addRecordAlias(recordsMap, record.studentUser, record);
        addRecordAlias(recordsMap, record.studentDocId, record);
        addRecordAlias(recordsMap, record.studentUserId, record);
      });
    }
    const reportCommentsMap = {};
    termSbaRecords.forEach((termRecord) => {
      (termRecord.records || []).forEach((record) => {
        addCommentAlias(reportCommentsMap, record.student, record);
        addCommentAlias(reportCommentsMap, record.studentUser, record);
        addCommentAlias(reportCommentsMap, record.studentDocId, record);
        addCommentAlias(reportCommentsMap, record.studentUserId, record);
      });
    });

    const mergedRecords = students.map((student) => {
      const studentDocId = toIdString(student._id);
      const studentUserId = toIdString(student.user?._id || student.user);
      const existingRecord = recordsMap[studentDocId] || recordsMap[studentUserId];
      const existingComments = reportCommentsMap[studentDocId] || reportCommentsMap[studentUserId] || {};

      if (existingRecord) {
        return {
          ...existingRecord,
          student: studentDocId,
          studentDocId,
          studentUser: studentUserId || null,
          studentUserId,
          studentName: student.user?.name || "Unknown",
          profilePicture: student.profilePicture || student.user?.profilePicture || "",
          conduct: existingComments.conduct || existingRecord.conduct || "",
          interest: existingComments.interest || existingRecord.interest || "",
          teacherRemarks: existingComments.teacherRemarks || existingRecord.teacherRemarks || "",
          nextTermBegins: existingComments.nextTermBegins || existingRecord.nextTermBegins || "",
          promotedTo: existingComments.promotedTo || existingRecord.promotedTo || "",
        };
      }

      // Default empty record for new student
      return {
        student: studentDocId,
        studentDocId,
        studentUser: studentUserId || null,
        studentUserId,
        studentName: student.user?.name || "Unknown",
        profilePicture: student.profilePicture || student.user?.profilePicture || "",
        classWork: "",
        classTest1: "",
        classTest2: "",
        projectWork: "",
        exams: "",
        total: "",
        grade: "",
        remarks: "",
        conduct: existingComments.conduct || "",
        interest: existingComments.interest || "",
        teacherRemarks: existingComments.teacherRemarks || "",
        nextTermBegins: existingComments.nextTermBegins || "",
        promotedTo: existingComments.promotedTo || "",
      };
    });

    // Sort by student name
    mergedRecords.sort((a, b) => (a.studentName || "").localeCompare(b.studentName || ""));

    return res.status(200).json({
      success: true,
      data: mergedRecords,
    });
  } catch (error) {
    console.error("Error fetching SBA V2 marks:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

/**
 * Save SBA Marks for a specific class, subject, and term.
 */
exports.saveSubjectMarks = async (req, res) => {
  try {
    const { schoolId, classId, termId, subjectId, records } = req.body;

    if (!schoolId || !classId || !termId || !subjectId || !records || !Array.isArray(records)) {
      return res.status(400).json({ message: "Missing required parameters or records payload" });
    }

    // Fetch the class to determine the grading system based on class name
    const classObj = await Class.findById(classId).lean();
    const className = classObj ? (classObj.name || "") : "";
    const studentDocs = await Student.find({ class: classId }).select("_id user").lean();
    const studentLookup = {};
    studentDocs.forEach((student) => {
      const studentDocId = toIdString(student._id);
      const studentUserId = toIdString(student.user);
      const entry = { studentDocId, studentUserId };
      if (studentDocId) studentLookup[studentDocId] = entry;
      if (studentUserId) studentLookup[studentUserId] = entry;
    });

    // Calculate totals and grades for all records
    const processedRecords = records.map((record) => {
      const matchedStudent =
        studentLookup[toIdString(record.student)] ||
        studentLookup[toIdString(record.studentDocId)] ||
        studentLookup[toIdString(record.studentUser)] ||
        studentLookup[toIdString(record.studentUserId)] ||
        {};
      const studentDocId = matchedStudent.studentDocId || toIdString(record.studentDocId) || toIdString(record.student);
      const studentUserId = matchedStudent.studentUserId || toIdString(record.studentUser) || toIdString(record.studentUserId) || null;
      const classWork = Math.min(Number(record.classWork) || 0, 10);
      const classTest1 = Math.min(Number(record.classTest1) || 0, 20);
      const classTest2 = Math.min(Number(record.classTest2) || 0, 30);
      const projectWork = Math.min(Number(record.projectWork) || 0, 10);
      const exams = Math.min(Number(record.exams) || 0, 100);
      
      const sbaTotal = classWork + classTest1 + classTest2 + projectWork;
      const scaledSba = Math.round((sbaTotal / 70) * 50) || 0;
      const scaledExams = Math.round((exams / 100) * 50) || 0;
      
      const total = scaledSba + scaledExams;
      const grade = calculateGrade(total, className);

      return {
        student: studentDocId,
        studentUser: studentUserId,
        classWork,
        classTest1,
        classTest2,
        projectWork,
        exams,
        total,
        grade,
        remarks: record.remarks || "",
        conduct: record.conduct || "",
        interest: record.interest || "",
        teacherRemarks: record.teacherRemarks || "",
        nextTermBegins: record.nextTermBegins || "",
        promotedTo: record.promotedTo || "",
      };
    });

    const sbaRecord = await SbaRecord.findOneAndUpdate(
      {
        school: schoolId,
        class: classId,
        term: termId,
        subject: subjectId,
      },
      {
        $set: {
          records: processedRecords,
        },
      },
      {
        new: true,
        upsert: true,
        sort: { updatedAt: -1 },
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Marks saved successfully",
      data: sbaRecord,
    });
  } catch (error) {
    console.error("Error saving SBA V2 marks:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.uploadGeneratedReportCards = [
  upload.single("reportPdf"),
  async (req, res) => {
    let tempFilePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({ message: "No report PDF uploaded" });
      }

      const { classId, termId, schoolId, studentOrder: studentOrderRaw } = req.body;

      if (!classId || !termId || !schoolId) {
        return res.status(400).json({
          message: "classId, termId, and schoolId are required",
        });
      }

      if (!mongoose.Types.ObjectId.isValid(termId)) {
        return res.status(400).json({
          message: "Invalid termId format. A valid MongoDB ObjectId is required.",
        });
      }

      const termDoc = await Term.findById(termId).lean();
      if (!termDoc) {
        return res.status(400).json({ message: "Term not found" });
      }

      const termKey = termDoc._id.toString();
      const termLabel = formatTermLabel(termDoc.term);
      const studentOrder = parseStringArray(studentOrderRaw);

      tempFilePath = req.file.path;
      const bucket = admin.storage().bucket();
      const destination = `reportcards/${schoolId}/${classId}/${termKey}/REPORT.pdf`;

      await bucket.upload(tempFilePath, {
        destination,
        metadata: { contentType: "application/pdf" },
      });

      const [pdfUrl] = await bucket.file(destination).getSignedUrl({
        action: "read",
        expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
      });

      const classDoc = await Class.findByIdAndUpdate(
        classId,
        { $set: { reportSheetPdfUrl: pdfUrl } },
        { new: true, runValidators: true }
      );

      if (!classDoc) {
        return res.status(404).json({ message: "Class not found" });
      }

      const students = await Student.find({ class: classId })
        .populate("user", "name")
        .populate("parent parentIds")
        .lean();

      if (!students.length) {
        return res.status(400).json({ message: "No students found for this class" });
      }

      applyStudentOrder(students, studentOrder);

      const pdfBytes = fs.readFileSync(tempFilePath);
      const finalDoc = await PDFDocument.load(pdfBytes);
      const pageCount = finalDoc.getPageCount();

      if (pageCount !== students.length) {
        console.warn("SBA V2 report PDF page/student count mismatch", {
          pageCount,
          studentCount: students.length,
        });
      }

      const uploadedReports = {};
      const notifications = [];
      const pagesToProcess = Math.min(pageCount, students.length);

      for (let i = 0; i < pagesToProcess; i += 1) {
        const student = students[i];

        try {
          const studentPdf = await PDFDocument.create();
          const [copiedPage] = await studentPdf.copyPages(finalDoc, [i]);
          studentPdf.addPage(copiedPage);

          const studentBytes = await studentPdf.save();
          const studentDest = `reportcards/${schoolId}/${classId}/${termKey}/${student._id}.pdf`;
          const file = bucket.file(studentDest);

          await file.save(studentBytes, {
            metadata: { contentType: "application/pdf" },
          });

          const [studentUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
          });

          uploadedReports[student._id] = studentUrl;

          await Student.findByIdAndUpdate(student._id, {
            $set: {
              [`reportCards.${termKey}`]: studentUrl,
              [`reportCardMetadata.${termKey}`]: {
                termNumber: termDoc.term,
                academicYear: termDoc.academicYear,
                uploadedAt: new Date(),
                uploadedBy: req.user?._id,
                source: "sba-v2",
              },
            },
          });

          const studentName = student.user?.name || student.name || "your child";
          const parentIds = getParentIds(student);
          const studentUserId = student.user?._id ? String(student.user._id) : null;

          const baseNotification = {
            title: "New Report Card Available",
            type: "report-card",
            category: "report",
            audience: "specific",
            class: classId,
            studentId: student._id,
            termId: termKey,
            termNumber: termDoc.term,
            academicYear: termDoc.academicYear,
            fileUrl: studentUrl,
            school: schoolId,
            sender: req.user?._id,
          };

          if (studentUserId) {
            notifications.push({
              ...baseNotification,
              message: `Your ${termLabel} report card has been uploaded.`,
              recipientUsers: [studentUserId],
            });
          }

          if (parentIds.length > 0) {
            notifications.push({
              ...baseNotification,
              message: `The ${termLabel} report card for ${studentName} is now available.`,
              recipientUsers: parentIds,
            });
          }
        } catch (error) {
          console.error(`Failed processing SBA V2 report for student ${student._id}:`, error);
        }
      }

      if (notifications.length) {
        try {
          await Notification.insertMany(notifications);

          const pushesByMessage = {};
          notifications.forEach((notification) => {
            if (!notification.recipientUsers || notification.recipientUsers.length === 0) return;
            if (!pushesByMessage[notification.message]) {
              pushesByMessage[notification.message] = new Set();
            }
            notification.recipientUsers.forEach(userId => pushesByMessage[notification.message].add(String(userId)));
          });

          for (const [message, userSet] of Object.entries(pushesByMessage)) {
            if (userSet.size > 0) {
              await sendPush([...userSet], "New Report Card Available", message)
                .catch(error => console.error("Push Error:", error));
            }
          }

          try {
            const smsService = require("../services/smsService");
            const settings = await smsService.getSchoolSettings(schoolId);
            if (settings.smsEnabled && settings.autoTriggers?.examReports) {
              for (const [message, userSet] of Object.entries(pushesByMessage)) {
                if (userSet.size === 0) continue;
                const targetUsers = await User.find({ _id: { $in: [...userSet] } }).select("phone").lean();
                const phones = targetUsers.map(user => user.phone).filter(Boolean);
                if (phones.length > 0) {
                  await smsService.sendSms({
                    schoolId,
                    recipients: phones,
                    message: `New Report Card: ${message}`,
                    messageType: "reports",
                  });
                }
              }
            }
          } catch (smsError) {
            console.error("SMS Auto-Trigger error in SBA V2 report cards:", smsError);
          }
        } catch (error) {
          console.warn("Failed to insert or push SBA V2 report notifications:", error.message || error);
        }
      }

      await Term.findByIdAndUpdate(termKey, {
        $set: { [`reportSheets.${classId}`]: pdfUrl },
      });

      return res.json({
        success: true,
        message: "SBA V2 report-card upload complete",
        class: classDoc.displayName || classDoc.name || "Class",
        term: {
          id: termKey,
          number: termDoc.term,
          academicYear: termDoc.academicYear,
        },
        totalStudents: students.length,
        uploadedCount: Object.keys(uploadedReports).length,
        classPdfUrl: pdfUrl,
        storagePath: `reportcards/${schoolId}/${classId}/${termKey}/`,
        perStudent: uploadedReports,
      });
    } catch (error) {
      console.error("Error in SBA V2 report-card upload:", error);
      return res.status(500).json({
        message: "Failed to process SBA V2 report cards",
        error: error.message,
      });
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  },
];
