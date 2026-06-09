const SbaRecord = require("../models/SbaRecord");
const Student = require("../models/Student");
const Class = require("../models/Class");
const User = require("../models/User");

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
    }).lean();
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
