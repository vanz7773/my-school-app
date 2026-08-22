const Student = require('../models/Student');
const Class = require('../models/Class');
const Term = require('../models/term');
const SbaRecord = require('../models/SbaRecord');

// Fixed ordering for class promotion
const classOrder = [
  'CRECHE',
  'NURSERY 1', 'NURSERY 2',
  'KG 1', 'KG 2',
  'BASIC 1', 'BASIC 2', 'BASIC 3', 'BASIC 4',
  'BASIC 5', 'BASIC 6', 'BASIC 7', 'BASIC 8', 'BASIC 9'
];

const normalizeClassLabel = (value) =>
  String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();

const normalizeTermLabel = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^term\b/i.test(raw) ? raw.replace(/\s+/g, ' ') : `Term ${raw}`;
};

const toTermAcademicYear = (value) =>
  String(value || '').trim().replace(/\s+to\s+/i, '-');

const getAcademicYearVariants = (value) => {
  const raw = String(value || '').trim();
  const termFormat = toTermAcademicYear(raw);
  const studentFormat = raw.replace(/\s*-\s*/g, ' to ');
  return [...new Set([raw, termFormat, studentFormat].filter(Boolean))];
};

const getNextAcademicYear = (value) => {
  const normalized = toTermAcademicYear(value);
  const match = normalized.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (!match) return '';

  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return '';

  return `${startYear + 1}-${endYear + 1}`;
};

const isRepeatedReportValue = (value, currentClass) => {
  const normalizedValue = normalizeClassLabel(value);
  if (!normalizedValue) return false;
  if (['REPEATED', 'REPEAT', 'REPEATING'].includes(normalizedValue)) return true;

  const currentNames = [
    currentClass?.displayName,
    currentClass?.name,
    currentClass?.stream ? `${currentClass.name}${currentClass.stream}` : '',
    currentClass?.stream ? `${currentClass.name} ${currentClass.stream}` : '',
  ].map(normalizeClassLabel).filter(Boolean);

  return currentNames.includes(normalizedValue);
};

const addClassAlias = (lookup, label, classId) => {
  const normalized = normalizeClassLabel(label);
  if (normalized && !lookup[normalized]) {
    lookup[normalized] = classId;
  }
};

const buildClassLookup = (classes) => {
  const lookup = {};
  const byId = {};

  classes.forEach((cls) => {
    const classId = String(cls._id);
    byId[classId] = cls;

    addClassAlias(lookup, cls.displayName, cls._id);
    addClassAlias(lookup, cls.name, cls._id);

    if (cls.stream) {
      addClassAlias(lookup, `${cls.name}${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.name} ${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.displayName}${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.displayName} ${cls.stream}`, cls._id);
    }
  });

  return { lookup, byId };
};

const getReportCardPromotions = async ({ schoolId, classId, fromYear, fromTerm }) => {
  const academicYearVariants = getAcademicYearVariants(fromYear);
  const termName = normalizeTermLabel(fromTerm);
  const termQuery = { school: schoolId, academicYear: { $in: academicYearVariants } };

  if (termName) {
    termQuery.term = termName;
  }

  const sourceTerm = await Term.findOne(termQuery)
    .sort({ academicYear: -1, term: -1, createdAt: -1 })
    .lean();

  if (!sourceTerm) {
    return {
      sourceTerm: null,
      promotions: {},
    };
  }

  const sbaRecords = await SbaRecord.find({
    school: schoolId,
    class: classId,
    term: sourceTerm._id,
  })
    .select('records.student records.studentUser records.promotedTo')
    .lean();

  const promotions = {};

  sbaRecords.forEach((subjectRecord) => {
    (subjectRecord.records || []).forEach((record) => {
      const promotedTo = String(record.promotedTo || '').trim();
      if (!promotedTo) return;

      [record.student, record.studentUser].forEach((id) => {
        const key = id ? String(id) : '';
        if (key && !promotions[key]) {
          promotions[key] = promotedTo;
        }
      });
    });
  });

  return {
    sourceTerm,
    promotions,
  };
};

exports.migrateStudents = async (req, res) => {
  const { fromYear, toYear, fromTerm, classId, students } = req.body;

  if (!fromYear) {
    return res.status(400).json({ message: 'Missing source academic year.' });
  }

  const fromYearForStudents = toTermAcademicYear(fromYear);
  const requestedToYear = toTermAcademicYear(toYear);
  const autoNextYear = getNextAcademicYear(fromYearForStudents);
  const toYearForStudents =
    requestedToYear && requestedToYear !== fromYearForStudents
      ? requestedToYear
      : autoNextYear;

  if (!toYearForStudents || fromYearForStudents === toYearForStudents) {
    return res.status(400).json({
      message: 'Could not determine the next academic year for promotion.',
    });
  }

  try {
    const schoolId = req.user.school;

    // ------------------------------------------------------------
    // 1. PRELOAD ALL CLASSES ONCE (FAST)
    // ------------------------------------------------------------
    const allClasses = await Class.find({ school: schoolId }).lean();

    const classMap = {};
    const promotionMap = {}; // className → nextClassId
    const { lookup: classLookup, byId: classById } = buildClassLookup(allClasses);

    allClasses.forEach(cls => {
      const name = normalizeClassLabel(cls.name);
      classMap[name] = cls._id;
    });

    // Build promotion mapping
    classOrder.forEach((className, index) => {
      const current = className.toUpperCase();
      const next = classOrder[index + 1]?.toUpperCase();

      if (classMap[current] && classMap[next]) {
        promotionMap[classMap[current]] = classMap[next]; // store classId → next classId
      }
    });

    // ------------------------------------------------------------
    // 2. LOAD STUDENTS TO MIGRATE (ONLY ONCE)
    // ------------------------------------------------------------
    let studentsToMigrate = [];
    const fromYearVariants = getAcademicYearVariants(fromYear);

    if (Array.isArray(students)) {
      if (students.length === 0) {
        return res.status(400).json({
          message: 'No students were selected for promotion.',
        });
      }

      // INDIVIDUAL MIGRATION
      const ids = students.map(s => s.studentId);
      const studentQuery = {
        school: schoolId,
        _id: { $in: ids },
        academicYear: { $in: fromYearVariants },
        status: { $ne: "graduated" }
      };

      if (classId) {
        studentQuery.class = classId;
      }

      studentsToMigrate = await Student.find(studentQuery)
      .select('class academicYear status user')
      .lean();
    }

    else if (classId) {
      // FULL CLASS MIGRATION
      studentsToMigrate = await Student.find({
        school: schoolId,
        class: classId,
        academicYear: { $in: fromYearVariants },
        status: { $ne: "graduated" }
      })
      .select('class academicYear status user')
      .lean();
    }

    else {
      return res.status(400).json({
        message: 'Provide either classId (full class migration) or students[] (individual migration).'
      });
    }

    if (studentsToMigrate.length === 0) {
      console.log('[Student Promotion] No eligible students found', {
        schoolId: String(schoolId),
        classId,
        fromYear,
        toYear,
        fromYearVariants,
      });

      return res.json({
        success: true,
        eligibleStudents: 0,
        migrated: 0,
        graduated: 0,
        modifiedStudents: 0,
        modifiedClassRosters: 0,
        message: "No eligible students to migrate.",
      });
    }

    // ------------------------------------------------------------
    // 3. PREPARE BULK UPDATE OPERATIONS
    // ------------------------------------------------------------
    const bulkOps = [];
    const classBulkOps = [];
    let migratedCount = 0;
    let graduatedCount = 0;
    let reportCardPromotionCount = 0;
    let reportCardRepeatCount = 0;
    let fallbackPromotionCount = 0;
    const unresolvedReportTargets = [];

    const reportCardPromotionData = classId
      ? await getReportCardPromotions({ schoolId, classId, fromYear, fromTerm })
      : { sourceTerm: null, promotions: {} };
    const reportPromotions = reportCardPromotionData.promotions || {};

    // Build a quick lookup for individual migration flags
    const promoteMap = {};
    if (Array.isArray(students)) {
      students.forEach(s => {
        promoteMap[s.studentId] = s.promote !== false; // default true
      });
    }

    // ------------------------------------------------------------
    // 4. PROCESS EACH STUDENT IN MEMORY (FAST)
    // ------------------------------------------------------------
    for (const student of studentsToMigrate) {
      const promote = Array.isArray(students)
        ? promoteMap[student._id] !== false
        : true;

      const currentClassId = String(student.class);
      const nextClassId = promotionMap[currentClassId]; // may be undefined
      const currentClass = classById[currentClassId];
      const reportPromotedTo =
        reportPromotions[String(student._id)] ||
        reportPromotions[String(student.user)] ||
        '';

      let newClassId = currentClassId;
      let shouldGraduate = false;

      if (promote && reportPromotedTo) {
        if (isRepeatedReportValue(reportPromotedTo, currentClass)) {
          newClassId = currentClassId;
          reportCardRepeatCount++;
        } else {
          const reportTargetClassId = classLookup[normalizeClassLabel(reportPromotedTo)];
          if (reportTargetClassId) {
            newClassId = reportTargetClassId;
            reportCardPromotionCount++;
          } else {
            unresolvedReportTargets.push({
              studentId: String(student._id),
              promotedTo: reportPromotedTo,
            });
            if (nextClassId) {
              newClassId = nextClassId;
              fallbackPromotionCount++;
            } else {
              shouldGraduate = true;
            }
          }
        }
      } else if (promote && nextClassId) {
        newClassId = nextClassId;
        fallbackPromotionCount++;
      } else if (promote && !nextClassId) {
        shouldGraduate = true;
      }

      // ------------ GRADUATION ------------
      if (shouldGraduate) {
        bulkOps.push({
          updateOne: {
            filter: { _id: student._id },
            update: {
              $set: {
                status: "graduated",
                academicYear: toYearForStudents,
                class: null
              }
            }
          }
        });
        if (student.user && currentClassId) {
          classBulkOps.push({
            updateOne: {
              filter: { _id: currentClassId, school: schoolId },
              update: { $pull: { students: student.user } },
            },
          });
        }
        graduatedCount++;
        continue;
      }

      // ------------ PROMOTION / MOVE ------------
      bulkOps.push({
        updateOne: {
          filter: { _id: student._id },
          update: {
            $set: {
              academicYear: toYearForStudents,
              class: newClassId,
              status: "active"
            }
          }
        }
      });
      if (student.user) {
        if (currentClassId && String(newClassId) !== currentClassId) {
          classBulkOps.push({
            updateOne: {
              filter: { _id: currentClassId, school: schoolId },
              update: { $pull: { students: student.user } },
            },
          });
        }

        if (newClassId) {
          classBulkOps.push({
            updateOne: {
              filter: { _id: newClassId, school: schoolId },
              update: { $addToSet: { students: student.user } },
            },
          });
        }
      }

      migratedCount++;
    }

    // ------------------------------------------------------------
    // 5. EXECUTE BULK OPERATION (SUPER FAST)
    // ------------------------------------------------------------
    let studentWriteResult = null;
    let classWriteResult = null;

    if (bulkOps.length > 0) {
      studentWriteResult = await Student.bulkWrite(bulkOps);
      if (classBulkOps.length > 0) {
        classWriteResult = await Class.bulkWrite(classBulkOps);
      }
    }

    const modifiedStudents =
      studentWriteResult?.modifiedCount ??
      studentWriteResult?.nModified ??
      0;
    const modifiedClassRosters =
      classWriteResult?.modifiedCount ??
      classWriteResult?.nModified ??
      0;

    console.log('[Student Promotion] Migration completed', {
      schoolId: String(schoolId),
      classId,
      fromYear: fromYearForStudents,
      toYear: toYearForStudents,
      sourceTerm: reportCardPromotionData.sourceTerm
        ? {
            id: String(reportCardPromotionData.sourceTerm._id),
            term: reportCardPromotionData.sourceTerm.term,
            academicYear: reportCardPromotionData.sourceTerm.academicYear,
          }
        : null,
      eligibleStudents: studentsToMigrate.length,
      migratedCount,
      graduatedCount,
      reportCardPromotionCount,
      reportCardRepeatCount,
      fallbackPromotionCount,
      unresolvedReportTargetCount: unresolvedReportTargets.length,
      studentOps: bulkOps.length,
      classOps: classBulkOps.length,
      modifiedStudents,
      modifiedClassRosters,
    });

    // ------------------------------------------------------------
    // 6. RESPONSE
    // ------------------------------------------------------------
    return res.json({
      success: true,
      eligibleStudents: studentsToMigrate.length,
      migrated: migratedCount,
      graduated: graduatedCount,
      modifiedStudents,
      modifiedClassRosters,
      sourceTerm: reportCardPromotionData.sourceTerm
        ? {
            id: String(reportCardPromotionData.sourceTerm._id),
            term: reportCardPromotionData.sourceTerm.term,
            academicYear: reportCardPromotionData.sourceTerm.academicYear,
          }
        : null,
      reportCardPromotionEntries: Object.keys(reportPromotions).length,
      reportCardPromotionsApplied: reportCardPromotionCount,
      reportCardRepeatsApplied: reportCardRepeatCount,
      fallbackPromotionsApplied: fallbackPromotionCount,
      unresolvedReportTargets,
      message: `${migratedCount} promoted, ${graduatedCount} graduated.`
    });

  } catch (err) {
    console.error('❌ Migration error:', err);
    return res.status(500).json({
      message: 'Migration failed.',
      error: err.message
    });
  }
};
