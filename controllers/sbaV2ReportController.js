const SbaRecord = require("../models/SbaRecord");
const Student = require("../models/Student");
const Class = require("../models/Class");
const User = require("../models/User");
const Subject = require("../models/Subject");

/**
 * Get aggregated SBA Marks for all subjects for a specific class and term.
 * Returns an array of students, each with a list of their subject marks.
 */
exports.getClassReportCards = async (req, res) => {
  try {
    const { schoolId, classId, termId } = req.query;

    if (!schoolId || !classId || !termId) {
      return res.status(400).json({ message: "Missing required parameters: schoolId, classId, termId" });
    }

    // 1. Find all students in the class
    const studentDocs = await Student.find({ class: classId })
      .populate("user", "name profilePicture")
      .lean();

    const students = studentDocs.filter(s => s.user);
    
    // 2. Fetch all SBA records for this class and term across all subjects
    const sbaRecords = await SbaRecord.find({
      school: schoolId,
      class: classId,
      term: termId,
    })
      .populate("subject", "name subjectName code")
      .lean();

    // 3. Build a map of studentId -> list of subject marks
    const studentMarksMap = {};
    
    // Initialize map
    students.forEach(student => {
      const studentId = String(student.user?._id || student.user);
      studentMarksMap[studentId] = {
        studentInfo: {
          id: studentId,
          name: student.user?.name || "Unknown",
          profilePicture: student.profilePicture || student.user?.profilePicture || "",
          studentId: student.studentId || "", // some models have an explicit string ID
          conduct: "",
          interest: "",
          teacherRemarks: "",
          promotedTo: "",
        },
        subjects: [],
        totalMarks: 0,
        averageMarks: 0,
      };
    });

    // Populate marks from sbaRecords and compute ranks
    sbaRecords.forEach(sba => {
      const subjectInfo = {
        id: String(sba.subject?._id || sba.subject),
        name: sba.subject?.name || sba.subject?.subjectName || "Unknown Subject"
      };

      if (sba.records && Array.isArray(sba.records)) {
        // Compute scaled marks
        const recordsWithScaled = sba.records.map(record => {
          const classWork = Math.min(Number(record.classWork) || 0, 10);
          const classTest1 = Math.min(Number(record.classTest1) || 0, 20);
          const classTest2 = Math.min(Number(record.classTest2) || 0, 30);
          const projectWork = Math.min(Number(record.projectWork) || 0, 10);
          const exams = Math.min(Number(record.exams) || 0, 100);
          
          const sbaTotal = classWork + classTest1 + classTest2 + projectWork;
          const scaledSba = parseFloat(((sbaTotal / 70) * 50).toFixed(1)) || 0;
          const scaledExams = parseFloat(((exams / 100) * 50).toFixed(1)) || 0;
          
          return {
            ...record,
            scaledSba,
            scaledExams
          };
        });

        // Sort by total for rank (descending)
        recordsWithScaled.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
        
        let currentRank = 1;
        let previousTotal = null;

        recordsWithScaled.forEach((record, index) => {
          const total = Number(record.total) || 0;
          if (total !== previousTotal) {
            currentRank = index + 1;
            previousTotal = total;
          }
          record.subjectRank = currentRank;
        });

        // Add to student marks map
        recordsWithScaled.forEach(record => {
          const studentId = String(record.student);
          if (studentMarksMap[studentId]) {
            studentMarksMap[studentId].subjects.push({
              subject: subjectInfo,
              classWork: record.classWork || 0,
              classTest1: record.classTest1 || 0,
              classTest2: record.classTest2 || 0,
              projectWork: record.projectWork || 0,
              exams: record.exams || 0,
              scaledSba: record.scaledSba,
              scaledExams: record.scaledExams,
              total: record.total || 0,
              grade: record.grade || "-",
              remarks: record.remarks || "",
              subjectRank: record.subjectRank
            });

            // Extract report comments if present (takes the first non-empty value found across subjects)
            if (!studentMarksMap[studentId].studentInfo.conduct && record.conduct) {
              studentMarksMap[studentId].studentInfo.conduct = record.conduct;
            }
            if (!studentMarksMap[studentId].studentInfo.interest && record.interest) {
              studentMarksMap[studentId].studentInfo.interest = record.interest;
            }
            if (!studentMarksMap[studentId].studentInfo.teacherRemarks && record.teacherRemarks) {
              studentMarksMap[studentId].studentInfo.teacherRemarks = record.teacherRemarks;
            }
            if (!studentMarksMap[studentId].studentInfo.promotedTo && record.promotedTo) {
              studentMarksMap[studentId].studentInfo.promotedTo = record.promotedTo;
            }

            // Accrue total marks
            studentMarksMap[studentId].totalMarks += Number(record.total) || 0;
          }
        });
      }
    });

    // 4. Format the final output and calculate averages/positions
    let reportCards = Object.values(studentMarksMap);

    // Calculate averages and sort for positions
    reportCards = reportCards.map(report => {
      report.averageMarks = report.subjects.length > 0 
        ? parseFloat((report.totalMarks / report.subjects.length).toFixed(2)) 
        : 0;
      return report;
    });

    // Sort by average descending to determine position
    reportCards.sort((a, b) => b.averageMarks - a.averageMarks);

    // Assign positions
    reportCards = reportCards.map((report, index) => {
      report.position = index + 1;
      return report;
    });

    // Re-sort alphabetically for display consistency (optional, but standard)
    reportCards.sort((a, b) => a.studentInfo.name.localeCompare(b.studentInfo.name));

    return res.status(200).json({
      success: true,
      data: reportCards,
    });

  } catch (error) {
    console.error("Error fetching class report cards:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};
