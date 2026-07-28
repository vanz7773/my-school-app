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

const getDateDayKey = (value) => {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const dayIndex = date.getDay();
  if (dayIndex === 1) return 'M';
  if (dayIndex === 2) return 'T';
  if (dayIndex === 3) return 'W';
  if (dayIndex === 4) return 'TH';
  if (dayIndex === 5) return 'F';
  return null;
};

const buildCollectionDailyTotals = (record, amountPerDay) => {
  const totalsByDay = DAY_KEYS.reduce((acc, day) => {
    acc[day] = {
      day,
      key: day,
      count: 0,
      amount: 0,
    };
    return acc;
  }, {});

  (record.breakdown || []).forEach((entry) => {
    DAY_KEYS.forEach((coveredDay) => {
      if (normalizeStatus(entry.days?.[coveredDay]) !== 'paid') return;

      const collectionDay = getDateDayKey(entry.paidAt?.[coveredDay]) || coveredDay;
      if (!totalsByDay[collectionDay]) return;

      const dayAmount = Number(entry.classFeeAmount ?? amountPerDay) || 0;
      totalsByDay[collectionDay].count += 1;
      totalsByDay[collectionDay].amount += dayAmount;
    });
  });

  return DAY_KEYS.map((day) => totalsByDay[day]);
};

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

const getGuardianName = (student = {}) => (
  student.guardianName ||
  student.parentName ||
  student.parent?.name ||
  ''
);

const getGuardianPhone = (student = {}) => (
  student.guardianPhone ||
  student.parentPhone ||
  student.parent?.phone ||
  ''
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
  const dailyTotals = buildCollectionDailyTotals(record, amountPerDay);

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

exports.getClassFeeAuditReport = async (req, res) => {
  try {
    const { termId, week, day } = req.query;
    const schoolId = getSchoolId(req);

    if (!termId || !week || !day) {
      return res.status(400).json({
        success: false,
        message: 'Missing termId, week, or day',
      });
    }

    const weekNumber = normalizeWeek(week);
    const records = await ClassFeeRecord.find({
      school: schoolId,
      termId,
      week: weekNumber,
    })
      .populate('classId', 'name stream displayName level')
      .populate({
        path: 'breakdown.student',
        select: 'guardianName guardianPhone parentName parentPhone name surname otherNames user class',
        populate: { path: 'user', select: 'name firstName lastName' },
      })
      .lean();

    const generateReportForDay = (targetDay) => {
      const classReportMap = new Map();
      let dayGrandTotal = 0;
      let dayTotalPaid = 0;
      let dayTotalUnpaid = 0;

      records.forEach((record) => {
        const classId = String(record.classId?._id || record.classId || '');
        if (!classId) return;

        const className = getClassDisplayName(record.classId);
        let classEntry = classReportMap.get(classId);

        if (!classEntry) {
          classEntry = {
            classId,
            className,
            totalAmount: 0,
            paidCount: 0,
            unpaidCount: 0,
            students: [],
          };
          classReportMap.set(classId, classEntry);
        }

        (record.breakdown || []).forEach((entry) => {
          const normalizedDays = ensureDays(entry.days);
          const studentDoc = entry.student && typeof entry.student === 'object' ? entry.student : {};
          const studentId = String(studentDoc._id || entry.student || '');
          const amountPerDay = Number(entry.classFeeAmount ?? record.classFeeAmount) || 0;
          let amountPaidToday = 0;

          DAY_KEYS.forEach((coveredDay) => {
            if (normalizeStatus(normalizedDays[coveredDay]) !== 'paid') return;

            const collectionDay = getDateDayKey(entry.paidAt?.[coveredDay]) || coveredDay;
            if (collectionDay === targetDay) {
              amountPaidToday += amountPerDay;
            }
          });

          let status = normalizeStatus(normalizedDays[targetDay]);
          if (amountPaidToday > 0) {
            status = 'paid';
          }

          if (status === 'absent' && amountPaidToday <= 0) return;

          classEntry.totalAmount += amountPaidToday;
          dayGrandTotal += amountPaidToday;

          if (amountPaidToday > 0) {
            classEntry.paidCount += 1;
            dayTotalPaid += 1;
          } else if (status === 'unpaid') {
            classEntry.unpaidCount += 1;
            dayTotalUnpaid += 1;
          }

          classEntry.students.push({
            studentId,
            studentName: entry.studentName || getStudentName(studentDoc),
            status,
            amount: amountPaidToday,
            guardianName: getGuardianName(studentDoc),
            guardianPhone: getGuardianPhone(studentDoc),
          });
        });
      });

      const report = Array.from(classReportMap.values())
        .map((classEntry) => ({
          ...classEntry,
          students: classEntry.students.sort((a, b) => (
            (a.studentName || '').localeCompare(b.studentName || '')
          )),
        }))
        .sort((a, b) => (a.className || '').localeCompare(b.className || ''));

      return {
        day: targetDay,
        grandTotal: dayGrandTotal,
        totalPaid: dayTotalPaid,
        totalUnpaid: dayTotalUnpaid,
        report,
      };
    };

    const dayNames = { M: 'Monday', T: 'Tuesday', W: 'Wednesday', TH: 'Thursday', F: 'Friday' };
    const weeklyReports = DAY_KEYS.map(generateReportForDay);
    const weeklySummary = weeklyReports.reduce((summary, dayReport) => {
      summary.grandTotal += dayReport.grandTotal;
      summary.totalPaid += dayReport.totalPaid;
      summary.totalUnpaid += dayReport.totalUnpaid;
      summary.dailyTotals.push({
        day: dayReport.day,
        dayName: dayNames[dayReport.day] || dayReport.day,
        grandTotal: dayReport.grandTotal,
        totalPaid: dayReport.totalPaid,
        totalUnpaid: dayReport.totalUnpaid,
      });
      return summary;
    }, {
      grandTotal: 0,
      totalPaid: 0,
      totalUnpaid: 0,
      dailyTotals: [],
    });

    if (day === 'All') {
      return res.json({
        success: true,
        day,
        week: weekNumber,
        grandTotal: weeklySummary.grandTotal,
        totalPaid: weeklySummary.totalPaid,
        totalUnpaid: weeklySummary.totalUnpaid,
        weeklySummary,
        dailyReports: weeklyReports,
      });
    }

    const singleReport = weeklyReports.find((dayReport) => dayReport.day === day)
      || generateReportForDay(day);

    return res.json({
      success: true,
      day,
      week: weekNumber,
      grandTotal: singleReport.grandTotal,
      totalPaid: singleReport.totalPaid,
      totalUnpaid: singleReport.totalUnpaid,
      weeklySummary,
      report: singleReport.report,
    });
  } catch (error) {
    console.error('getClassFeeAuditReport error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch class fee audit report',
      error: error.message,
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
