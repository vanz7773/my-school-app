const Grade = require('../models/Grade');
const Student = require('../models/Student');
const User = require('../models/User');
const Class = require('../models/Class');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// === In-Memory Cache (Optional, short-lived) ===
const memoryCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

const getMemoryCache = (key) => {
  const item = memoryCache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  memoryCache.delete(key);
  return null;
};

const setMemoryCache = (key, data) => {
  memoryCache.set(key, { data, timestamp: Date.now() });
};

// === Optimized Grading Logic ===
class OptimizedSubjectRecord {
  constructor(studentId) {
    this.studentId = studentId;
    this.test1 = 0;
    this.test2 = 0;
    this.groupWork = 0;
    this.projectWork = 0;
    this.exam = 0;
    // Precompute values for memoization
    this._totalCA = null;
    this._scaledCA = null;
    this._exam50 = null;
    this._overall = null;
    this._grade = null;
  }

  totalCA() {
    if (this._totalCA === null) {
      this._totalCA = this.test1 + this.test2 + this.groupWork + this.projectWork;
    }
    return this._totalCA;
  }

  scaledCA() {
    if (this._scaledCA === null) {
      this._scaledCA = (this.totalCA() / 60) * 50;
    }
    return this._scaledCA;
  }

  exam50() {
    if (this._exam50 === null) {
      this._exam50 = this.exam * 0.5;
    }
    return this._exam50;
  }

  overall() {
    if (this._overall === null) {
      this._overall = this.scaledCA() + this.exam50();
    }
    return this._overall;
  }

  grade() {
    if (this._grade === null) {
      const score = this.overall();
      if (score > 79) this._grade = 'A';
      else if (score > 75) this._grade = 'P';
      else if (score > 65) this._grade = 'AP';
      else if (score > 64.5) this._grade = 'D';
      else this._grade = 'B';
    }
    return this._grade;
  }

  remarks() {
    const gradeMap = {
      'A': 'ADVANCE',
      'P': 'PROFICIENT', 
      'AP': 'APPROACHING PROFICIENCY',
      'D': 'DEVELOPING',
      'B': 'BEGINNING'
    };
    return gradeMap[this.grade()] || '';
  }
}

// ========================
// OPTIMIZED: POST /grades/add
// ========================
exports.addGrades = async (req, res) => {
  const session = await Grade.startSession();
  session.startTransaction();
  
  try {
    const { records } = req.body;
    const schoolId = req.user.school;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'Invalid input. "records" must be a non-empty array.' });
    }

    // Batch fetch all students and classes for validation
    const studentIds = [...new Set(records.map(r => r.studentId))];
    const classIds = [...new Set(records.map(r => r.classId))];

    const [students, classes] = await Promise.all([
      Student.find({ _id: { $in: studentIds } }).populate('class').lean(),
      Class.find({ _id: { $in: classIds } }).lean()
    ]);

    const studentMap = new Map(students.map(s => [s._id.toString(), s]));
    const classMap = new Map(classes.map(c => [c._id.toString(), c]));

    // Batch duplicate check
    const duplicateCheckConditions = records.map(record => ({
      student: record.studentId,
      subject: record.subject,
      class: record.classId,
      term: record.term
    }));

    const existingGrades = await Grade.find({
      $or: duplicateCheckConditions
    }).select('student subject class term').lean();

    const existingGradeMap = new Map(
      existingGrades.map(grade => [
        `${grade.student}-${grade.subject}-${grade.class}-${grade.term}`, 
        true
      ])
    );

    const validRecords = [];
    const skippedRecords = [];

    // Process records with pre-fetched data
    for (const record of records) {
      const student = studentMap.get(record.studentId);
      const classInfo = classMap.get(record.classId);
      const studentSchoolId = student?.class?.school || student?.school;

      if (!student || String(studentSchoolId) !== String(schoolId) || !classInfo || String(classInfo.school) !== String(schoolId)) {
        skippedRecords.push({ ...record, reason: 'Invalid student/class for this school' });
        continue;
      }

      const gradeKey = `${record.studentId}-${record.subject}-${record.classId}-${record.term}`;
      if (existingGradeMap.has(gradeKey)) {
        skippedRecords.push({ ...record, reason: 'Duplicate grade exists' });
        continue;
      }

      const calc = new OptimizedSubjectRecord(record.studentId);
      calc.test1 = record.test1 || 0;
      calc.test2 = record.test2 || 0;
      calc.groupWork = record.groupWork || 0;
      calc.projectWork = record.projectWork || 0;
      calc.exam = record.exam || 0;

      validRecords.push({
        student: record.studentId,
        subject: record.subject,
        class: record.classId,
        term: record.term,
        test1: calc.test1,
        test2: calc.test2,
        groupWork: calc.groupWork,
        projectWork: calc.projectWork,
        exam: calc.exam,
        comment: record.comment || '',
        enteredBy: req.user.id,
        school: schoolId
      });
    }

    if (validRecords.length === 0) {
      await session.abortTransaction();
      return res.status(200).json({
        message: 'No valid grades to add.',
        addedCount: 0,
        results: [],
        skippedRecords,
      });
    }

    const results = await Grade.insertMany(validRecords, { 
      session, 
      ordered: false 
    });

    await session.commitTransaction();
    
    // Clear memory cache for affected report cards
    setImmediate(() => {
      validRecords.forEach(record => {
        memoryCache.delete(`report_card:${record.student}:${record.term}`);
      });
    });

    res.status(201).json({
      message: 'Grades added successfully',
      addedCount: results.length,
      results,
      skippedRecords,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('❌ Error inserting grades:', err.message);
    res.status(500).json({ message: 'Error adding grades', error: err.message });
  } finally {
    session.endSession();
  }
};

// ========================
// OPTIMIZED: GET /grades/report-card
// ========================
exports.getReportCard = async (req, res) => {
  try {
    const { studentId, classId, term } = req.query;
    const schoolId = req.user.school;

    // Simple memory caching for frequent requests
    if (studentId && term) {
      const cacheKey = `report_card:${studentId}:${term}`;
      const cached = getMemoryCache(cacheKey);
      if (cached) {
        return res.status(200).json({ reportCard: cached });
      }
    }

    const filter = { school: schoolId };
    if (studentId) filter.student = studentId;
    if (classId) filter.class = classId;
    if (term) filter.term = term;

    // Aggregation pipeline for optimized data fetching
    const grades = await Grade.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'students',
          localField: 'student',
          foreignField: '_id',
          as: 'student',
          pipeline: [
            {
              $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'user',
                pipeline: [{ $project: { name: 1, email: 1 } }]
              }
            },
            { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
            { $project: { admissionNumber: 1, user: 1 } }
          ]
        }
      },
      { $unwind: '$student' },
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'class',
          pipeline: [{ $project: { name: 1 } }]
        }
      },
      { $unwind: { path: '$class', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'enteredBy',
          foreignField: '_id',
          as: 'enteredBy',
          pipeline: [{ $project: { name: 1 } }]
        }
      },
      { $unwind: { path: '$enteredBy', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          subject: 1,
          test1: 1,
          test2: 1,
          groupWork: 1,
          projectWork: 1,
          exam: 1,
          comment: 1,
          term: 1,
          'student._id': 1,
          'student.admissionNumber': 1,
          'student.user.name': 1,
          'student.user.email': 1,
          'class.name': 1,
          'enteredBy.name': 1
        }
      }
    ]);

    if (!grades || grades.length === 0) {
      return res.status(404).json({ message: 'No grades found for this student/class/term.' });
    }

    const student = grades[0].student;
    const className = grades[0].class?.name || 'Unknown';

    // Process subjects with optimized calculations
    const subjects = grades.map((g) => {
      const calc = new OptimizedSubjectRecord(g.student._id);
      calc.test1 = g.test1 || 0;
      calc.test2 = g.test2 || 0;
      calc.groupWork = g.groupWork || 0;
      calc.projectWork = g.projectWork || 0;
      calc.exam = g.exam || 0;

      return {
        subject: g.subject,
        test1: calc.test1,
        test2: calc.test2,
        groupWork: calc.groupWork,
        projectWork: calc.projectWork,
        exam: calc.exam,
        scaledCA: calc.scaledCA(),
        exam50: calc.exam50(),
        overall: calc.overall(),
        grade: calc.grade(),
        remarks: calc.remarks(),
        comment: g.comment,
        enteredBy: g.enteredBy?.name || 'Unknown',
      };
    });

    const totalScore = subjects.reduce((sum, s) => sum + s.overall, 0);
    const averageScore = subjects.length > 0 ? (totalScore / subjects.length).toFixed(2) : '0.00';

    const reportCard = {
      student: {
        id: student._id,
        name: student.user?.name || 'Unnamed',
        email: student.user?.email || 'N/A',
        admissionNumber: student.admissionNumber || 'N/A',
      },
      class: className,
      term: term || 'N/A',
      totalSubjects: subjects.length,
      totalScore,
      averageScore,
      subjects,
    };

    // Cache in memory for frequent requests
    if (studentId && term) {
      setMemoryCache(`report_card:${studentId}:${term}`, reportCard);
    }

    res.status(200).json({ reportCard });
  } catch (err) {
    console.error('❌ Error generating report card:', err.message);
    res.status(500).json({ message: 'Error generating report card', error: err.message });
  }
};

// ========================
// OPTIMIZED: GET /grades/entry-setup
// ========================
exports.getGradeEntrySetup = async (req, res) => {
  try {
    const { classId, subject, term } = req.query;
    const schoolId = req.user.school;

    // Memory cache for setup data
    const cacheKey = `grade_setup:${classId}:${subject}:${term}`;
    const cached = getMemoryCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const classDoc = await Class.findOne({ _id: classId, school: schoolId })
      .select('name')
      .lean();
    
    if (!classDoc) {
      return res.status(404).json({ message: 'Class not found or not part of your school' });
    }

    // Optimized student query with projection
    const students = await Student.find({ class: classId })
      .populate('user', 'name')
      .select('admissionNumber user')
      .lean();

    const studentList = students.map((s) => ({
      id: s._id,
      name: s.user?.name || 'Unnamed',
      admissionNumber: s.admissionNumber || '',
    }));

    const response = {
      class: classDoc.name,
      subject,
      term,
      students: studentList
    };

    // Cache in memory
    setMemoryCache(cacheKey, response);

    res.status(200).json(response);
  } catch (err) {
    console.error('❌ Error fetching entry setup:', err.message);
    res.status(500).json({ message: 'Failed to fetch entry setup', error: err.message });
  }
};

// ========================
// OPTIMIZED: GET /grades/all
// ========================
exports.getAllGrades = async (req, res) => {
  try {
    const schoolId = req.user.school;
    
    // Use lean query with proper projection
    const grades = await Grade.find({ school: schoolId })
      .populate('student', 'admissionNumber')
      .populate('class', 'name')
      .select('subject test1 test2 groupWork projectWork exam term createdAt')
      .sort({ createdAt: -1 })
      .lean()
      .limit(1000); // Add reasonable limit

    res.status(200).json({ grades });
  } catch (err) {
    console.error('Error fetching all grades:', err.message);
    res.status(500).json({ message: 'Failed to fetch grades', error: err.message });
  }
};

// ========================
// OPTIMIZED: PATCH /grades/:gradeId
// ========================
exports.updateGrade = async (req, res) => {
  const session = await Grade.startSession();
  session.startTransaction();

  try {
    const { gradeId } = req.params;
    const schoolId = req.user.school;

    // Atomic update with security check
    const grade = await Grade.findOneAndUpdate(
      { 
        _id: gradeId, 
        school: schoolId
      },
      {
        $set: {
          ...(req.body.test1 !== undefined && { test1: req.body.test1 }),
          ...(req.body.test2 !== undefined && { test2: req.body.test2 }),
          ...(req.body.groupWork !== undefined && { groupWork: req.body.groupWork }),
          ...(req.body.projectWork !== undefined && { projectWork: req.body.projectWork }),
          ...(req.body.exam !== undefined && { exam: req.body.exam }),
          ...(req.body.comment !== undefined && { comment: req.body.comment }),
        }
      },
      { 
        new: true,
        session,
        runValidators: true 
      }
    );

    if (!grade) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Grade not found or unauthorized' });
    }

    await session.commitTransaction();

    // Clear relevant memory cache
    setImmediate(() => {
      memoryCache.delete(`report_card:${grade.student}:${grade.term}`);
    });

    res.status(200).json({
      message: 'Grade updated successfully',
      grade
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('❌ Error updating grade:', err.message);
    res.status(500).json({ message: 'Failed to update grade', error: err.message });
  } finally {
    session.endSession();
  }
};

// ========================
// OPTIMIZED PDF Generation
// ========================
exports.generateReportCardPDF = async (req, res) => {
  try {
    const { studentId, term } = req.query;
    const schoolId = req.user.school;

    if (!studentId || !term) {
      return res.status(400).json({ message: 'studentId and term are required' });
    }

    // Use aggregation for efficient data fetching
    const grades = await Grade.aggregate([
      { 
        $match: { 
          student: new mongoose.Types.ObjectId(studentId), 
          term, 
          school: new mongoose.Types.ObjectId(schoolId) 
        } 
      },
      {
        $lookup: {
          from: 'students',
          localField: 'student',
          foreignField: '_id',
          as: 'student',
          pipeline: [
            {
              $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'user',
                pipeline: [{ $project: { name: 1 } }]
              }
            },
            { $unwind: '$user' }
          ]
        }
      },
      { $unwind: '$student' },
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'class',
          pipeline: [{ $project: { name: 1 } }]
        }
      },
      { $unwind: '$class' }
    ]);

    if (!grades || grades.length === 0) {
      return res.status(404).json({ message: 'No grades found for this student/term' });
    }

    // PDF generation code remains similar but more efficient
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report_card_${studentId}.pdf`);
    doc.pipe(res);

    // ... existing PDF generation code with precomputed calculations
    const student = grades[0].student;
    const className = grades[0].class.name;

    // Header
    doc.fontSize(18).text('School Report Card', 50, 50);
    doc.fontSize(12);
    doc.text(`Student: ${student.user.name}`, 50, 80);
    doc.text(`Class: ${className}`, 50, 95);
    doc.text(`Term: ${term}`, 50, 110);

    // Table with precomputed data
    let yPosition = 140;
    grades.forEach(grade => {
      const calc = new OptimizedSubjectRecord(studentId);
      calc.test1 = grade.test1;
      calc.test2 = grade.test2;
      calc.groupWork = grade.groupWork;
      calc.projectWork = grade.projectWork;
      calc.exam = grade.exam;

      doc.text(grade.subject, 50, yPosition);
      doc.text(calc.overall().toFixed(2), 200, yPosition);
      doc.text(calc.grade(), 250, yPosition);
      yPosition += 20;
    });

    doc.end();
  } catch (err) {
    console.error('❌ Error generating PDF report:', err.message);
    res.status(500).json({ message: 'Failed to generate PDF report', error: err.message });
  }
};