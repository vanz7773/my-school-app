const Class = require('../models/Class');
const ClassFeeConfig = require('../models/ClassFeeConfig');
const ClassFeeRecord = require('../models/ClassFeeRecord');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');

const DAY_KEYS = ['M', 'T', 'W', 'TH', 'F'];

const normalizeStatus = (value) => {
  if (value === true || value === 'present' || value === 'paid') return 'paid';
  if (value === false || value === 'absent') return 'absent';
  if (value === 'unpaid') return 'unpaid';
  return 'notmarked';
};

const normalizeDay = (day) => String(day || '').toUpperCase().trim();

const normalizeWeek = (week) => {
  const parsed = parseInt(String(week || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const ensureDays = (days = {}) => (
  DAY_KEYS.reduce((acc, day) => {
    acc[day] = normalizeStatus(days?.[day]);
    return acc;
  }, {})
);

const getSchoolId = (req) => req.user?.school;

const getClassDisplayName = (classDoc = {}) => (
  classDoc.displayName ||
  (classDoc.stream ? `${classDoc.name}${classDoc.stream}` : classDoc.name) ||
  'Class'
);

const getStudentName = (student = {}) => (
  student.user?.name ||
  [student.surname, student.otherNames].filter(Boolean).join(' ') ||
  student.name ||
  'Student'
);

const getConfigForSchool = async (schoolId) => ClassFeeConfig.findOneAndUpdate(
  { school: schoolId },
  { $setOnInsert: { school: schoolId } },
  { new: true, upsert: true }
);

const assertClassAccess = async (req, classId) => {
  const schoolId = getSchoolId(req);
  const classDoc = await Class.findOne({ _id: classId, school: schoolId }).lean();

  if (!classDoc) {
    const err = new Error('Class not found');
    err.statusCode = 404;
    throw err;
  }

  if (req.user?.role !== 'teacher') {
    return classDoc;
  }

  const userId = String(req.user._id);
  const directlyAssigned = [
    ...(classDoc.teachers || []),
    classDoc.classTeacher,
    classDoc.coClassTeacher,
  ]
    .filter(Boolean)
    .some((id) => String(id) === userId);

  if (directlyAssigned) {
    return classDoc;
  }

  const teacherDoc = await Teacher.findOne({
    user: req.user._id,
    school: schoolId,
    assignedClasses: classDoc._id,
  }).lean();

  if (teacherDoc) {
    return classDoc;
  }

  const err = new Error('You are not assigned to this class');
  err.statusCode = 403;
  throw err;
};

const serializeConfigBands = (config) => {
  const bands = ClassFeeConfig.getClassFeeBands(config);
  return Object.entries(bands || {}).reduce((acc, [classId, band]) => {
    if (band && typeof band === 'object') {
      acc[classId] = {
        className: band.className || '',
        amount: Number(band.amount) || 0,
      };
    } else {
      acc[classId] = {
        className: '',
        amount: Number(band) || 0,
      };
    }
    return acc;
  }, {});
};

const serializeRecord = (record, classDoc, amountPerDay) => {
  const dailyTotals = DAY_KEYS.map((day) => {
    const count = (record.breakdown || []).filter((entry) => (
      normalizeStatus(entry.days?.[day]) === 'paid'
    )).length;

    return {
      day,
      key: day,
      count,
      amount: count * (Number(amountPerDay) || 0),
    };
  });

  return {
    success: true,
    recordId: record._id,
    classId: record.classId,
    className: getClassDisplayName(classDoc),
    termId: record.termId,
    week: record.week,
    amountPerDay: Number(amountPerDay) || 0,
    totalAmount: Number(record.totalCollected) || 0,
    paidCount: Number(record.paidCount) || 0,
    unpaidCount: Number(record.unpaidCount) || 0,
    absentCount: Number(record.absentCount) || 0,
    studentCount: Array.isArray(record.breakdown) ? record.breakdown.length : 0,
    dailyTotals,
    breakdown: (record.breakdown || []).map((entry) => ({
      studentId: entry.student,
      studentName: entry.studentName,
      className: entry.className || getClassDisplayName(classDoc),
      amountPerDay: Number(entry.classFeeAmount ?? amountPerDay) || 0,
      days: ensureDays(entry.days),
      daysPaid: Number(entry.daysPaid) || 0,
      total: Number(entry.total) || 0,
    })),
  };
};

const loadOrCreateRecord = async (req, { classId, termId, week }) => {
  if (!classId || !termId) {
    const err = new Error('Class and term are required');
    err.statusCode = 400;
    throw err;
  }

  const schoolId = getSchoolId(req);
  const classDoc = await assertClassAccess(req, classId);
  const config = await getConfigForSchool(schoolId);
  const amountPerDay = ClassFeeConfig.getAmountForClass(config, classDoc);
  const weekNumber = normalizeWeek(week);

  const students = await Student.find({
    school: schoolId,
    class: classDoc._id,
    status: 'active',
  })
    .populate('user', 'name')
    .select('_id user surname otherNames class status')
    .lean();

  const sortedStudents = students.sort((a, b) => (
    getStudentName(a).localeCompare(getStudentName(b))
  ));

  let record = await ClassFeeRecord.findOne({
    school: schoolId,
    classId: classDoc._id,
    termId,
    week: weekNumber,
  });

  const existingByStudent = new Map(
    (record?.breakdown || []).map((entry) => [String(entry.student), entry])
  );

  const className = getClassDisplayName(classDoc);
  const breakdown = sortedStudents.map((student) => {
    const existing = existingByStudent.get(String(student._id));
    return {
      student: student._id,
      studentName: getStudentName(student),
      className,
      classFeeAmount: amountPerDay,
      days: ensureDays(existing?.days),
      paidAt: existing?.paidAt || {},
      lastUpdatedBy: existing?.lastUpdatedBy,
      lastUpdatedAt: existing?.lastUpdatedAt || new Date(),
    };
  });

  if (!record) {
    record = new ClassFeeRecord({
      school: schoolId,
      classId: classDoc._id,
      termId,
      week: weekNumber,
      classFeeAmount: amountPerDay,
      updatedBy: req.user?._id,
      breakdown,
    });
  } else {
    record.classFeeAmount = amountPerDay;
    record.updatedBy = req.user?._id;
    record.breakdown = breakdown;
  }

  await record.save();

  return { record, classDoc, amountPerDay };
};

exports.getClassFeeConfig = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const [config, classes] = await Promise.all([
      getConfigForSchool(schoolId),
      Class.find({ school: schoolId })
        .select('_id name stream displayName')
        .sort({ name: 1, stream: 1 })
        .lean(),
    ]);

    res.json({
      success: true,
      currency: config.currency || 'GHS',
      classFeeBands: serializeConfigBands(config),
      classes: classes.map((cls) => ({
        _id: cls._id,
        name: cls.name,
        stream: cls.stream,
        displayName: getClassDisplayName(cls),
      })),
    });
  } catch (error) {
    console.error('getClassFeeConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to load class fee config' });
  }
};

exports.setClassFeeConfig = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const incomingBands = req.body?.classFeeBands || {};
    const currency = req.body?.currency || 'GHS';

    const classes = await Class.find({ school: schoolId })
      .select('_id name stream displayName')
      .lean();

    const classFeeBands = {};
    classes.forEach((cls) => {
      const classId = String(cls._id);
      const incoming = incomingBands[classId] || {};
      const rawAmount = typeof incoming === 'object' ? incoming.amount : incoming;
      classFeeBands[classId] = {
        className: getClassDisplayName(cls),
        amount: Math.max(0, Number(rawAmount) || 0),
      };
    });

    const config = await ClassFeeConfig.findOneAndUpdate(
      { school: schoolId },
      {
        $set: {
          classFeeBands,
          currency,
          updatedBy: req.user?._id,
          lastUpdated: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    res.json({
      success: true,
      message: 'Class fee amounts updated successfully',
      classFeeBands: serializeConfigBands(config),
      currency: config.currency || 'GHS',
    });
  } catch (error) {
    console.error('setClassFeeConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to save class fee config' });
  }
};

exports.calculateClassFeeCollection = async (req, res) => {
  try {
    const { classId, termId } = req.body;
    const week = req.body.week || req.query.week;
    const { record, classDoc, amountPerDay } = await loadOrCreateRecord(req, {
      classId,
      termId,
      week,
    });

    res.json(serializeRecord(record, classDoc, amountPerDay));
  } catch (error) {
    console.error('calculateClassFeeCollection error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to calculate class fees',
    });
  }
};

exports.getClassFeeSummary = async (req, res) => {
  try {
    const { classId, termId, week } = req.query;
    const { record, classDoc, amountPerDay } = await loadOrCreateRecord(req, {
      classId,
      termId,
      week,
    });

    res.json(serializeRecord(record, classDoc, amountPerDay));
  } catch (error) {
    console.error('getClassFeeSummary error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to load class fee summary',
    });
  }
};

exports.markClassFeeBulk = async (req, res) => {
  try {
    const { classId, termId, marks = [] } = req.body;
    const week = req.body.week || req.query.week;

    if (!Array.isArray(marks) || marks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No class fee marks provided',
      });
    }

    const { record, classDoc, amountPerDay } = await loadOrCreateRecord(req, {
      classId,
      termId,
      week,
    });

    const entryByStudent = new Map(
      (record.breakdown || []).map((entry) => [String(entry.student), entry])
    );

    marks.forEach((mark) => {
      const studentId = String(mark.student || mark.studentId || '');
      const day = normalizeDay(mark.day || mark.dayKey);
      const status = normalizeStatus(mark.status ?? mark.feeStatus ?? mark.fed);

      if (!DAY_KEYS.includes(day) || !studentId) return;

      const entry = entryByStudent.get(studentId);
      if (!entry) return;

      entry.days[day] = status;
      entry.lastUpdatedBy = req.user?._id;
      entry.lastUpdatedAt = new Date();
      entry.paidAt = entry.paidAt || {};
      entry.paidAt[day] = status === 'paid' ? new Date() : null;
    });

    record.updatedBy = req.user?._id;
    await record.save();

    res.json({
      ...serializeRecord(record, classDoc, amountPerDay),
      message: 'Class fee marks saved successfully',
    });
  } catch (error) {
    console.error('markClassFeeBulk error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to save class fee marks',
    });
  }
};
