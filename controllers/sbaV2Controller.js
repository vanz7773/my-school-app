const SbaRecord = require("../models/SbaRecord");
const Student = require("../models/Student");
const Class = require("../models/Class");

// Calculate total and grade automatically if not provided or to ensure accuracy
const calculateGrade = (total) => {
  if (total >= 80) return "A";
  if (total >= 70) return "B";
  if (total >= 60) return "C";
  if (total >= 50) return "D";
  if (total >= 40) return "E";
  return "F";
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

    // 1. Find all active students in the class
    const students = await Student.find({
      school: schoolId,
      class: classId,
      $or: [{ status: "active" }, { status: { $exists: false } }, { status: null }]
    })
      .populate("user", "name profilePicture")
      .lean();
    
    console.log(`Found ${students.length} students for class ${classId}`);

    // 2. Find existing marks
    const sbaRecord = await SbaRecord.findOne({
      school: schoolId,
      class: classId,
      term: termId,
      subject: subjectId,
    }).lean();

    // 3. Map students to their marks, generating an empty mark object if none exists
    const recordsMap = {};
    if (sbaRecord && sbaRecord.records) {
      sbaRecord.records.forEach((record) => {
        recordsMap[String(record.student)] = record;
      });
    }

    const mergedRecords = students.map((student) => {
      const studentId = String(student._id);
      const existingRecord = recordsMap[studentId];

      if (existingRecord) {
        return {
          ...existingRecord,
          studentName: student.user?.name || `${student.surname || ""} ${student.otherNames || ""}`.trim() || "Unknown",
          profilePicture: student.profilePicture || student.user?.profilePicture || "",
        };
      }

      // Default empty record for new student
      return {
        student: studentId,
        studentName: student.user?.name || `${student.surname || ""} ${student.otherNames || ""}`.trim() || "Unknown",
        profilePicture: student.profilePicture || student.user?.profilePicture || "",
        classWork: "",
        homework: "",
        projectWork: "",
        exams: "",
        total: "",
        grade: "",
        remarks: "",
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

    // Optional: Validation to check if user is class teacher or subject teacher
    // We assume frontend guards this, but in production we might want backend auth checks here.

    // Calculate totals and grades for all records
    const processedRecords = records.map((record) => {
      const classWork = Number(record.classWork) || 0;
      const homework = Number(record.homework) || 0;
      const projectWork = Number(record.projectWork) || 0;
      const exams = Number(record.exams) || 0;
      const total = classWork + homework + projectWork + exams;
      const grade = calculateGrade(total);

      return {
        student: record.student,
        classWork,
        homework,
        projectWork,
        exams,
        total,
        grade,
        remarks: record.remarks || "",
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
