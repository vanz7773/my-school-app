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

const normalizedClassOrder = classOrder.map(normalizeClassLabel);

const parseClassLabel = (value) => {
  const normalized = normalizeClassLabel(value);
  if (!normalized) return { baseName: '', stream: '' };

  for (const className of classOrder) {
    const baseName = normalizeClassLabel(className);
    const compactBaseName = baseName.replace(/\s+/g, '');
    const compactLabel = normalized.replace(/\s+/g, '');

    if (normalized === baseName || compactLabel === compactBaseName) {
      return { baseName, stream: '' };
    }

    if (normalized.startsWith(`${baseName} `)) {
      const stream = normalized.slice(baseName.length).trim();
      if (/^[A-Z]$/.test(stream)) {
        return { baseName, stream };
      }
    }

    if (compactLabel.startsWith(compactBaseName)) {
      const stream = compactLabel.slice(compactBaseName.length);
      if (/^[A-Z]$/.test(stream)) {
        return { baseName, stream };
      }
    }
  }

  return { baseName: normalized, stream: '' };
};

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

const getClassBaseName = (currentClass) => {
  const possibleNames = [
    currentClass?.name,
    currentClass?.displayName,
  ].map(normalizeClassLabel).filter(Boolean);

  for (const name of possibleNames) {
    const { baseName } = parseClassLabel(name);
    if (normalizedClassOrder.includes(baseName)) {
      return baseName;
    }
  }

  return possibleNames[0] || '';
};

const getClassStream = (currentClass) => {
  const directStream = normalizeClassLabel(currentClass?.stream);
  if (directStream) return directStream;

  const possibleNames = [
    currentClass?.displayName,
    currentClass?.name,
  ].map(normalizeClassLabel).filter(Boolean);

  for (const name of possibleNames) {
    const { stream } = parseClassLabel(name);
    if (stream) return stream;
  }

  return '';
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

const getClassOrderIndex = (currentClass) =>
  normalizedClassOrder.findIndex((className) => className === getClassBaseName(currentClass));

const getExpectedNextClassName = (currentClass) => {
  const classIndex = getClassOrderIndex(currentClass);
  if (classIndex < 0) return '';
  return classOrder[classIndex + 1] || '';
};

const isGraduationClass = (currentClass) =>
  getClassOrderIndex(currentClass) === classOrder.length - 1;

const addClassAlias = (lookup, label, classId) => {
  const normalized = normalizeClassLabel(label);
  if (normalized && !lookup[normalized]) {
    lookup[normalized] = classId;
  }
};

const buildClassLookup = (classes) => {
  const lookup = {};
  const byId = {};
  const classesByBaseName = {};

  classes.forEach((cls) => {
    const classId = String(cls._id);
    byId[classId] = cls;

    const baseName = getClassBaseName(cls);
    const classStream = getClassStream(cls);
    const normalizedName = normalizeClassLabel(cls.name);
    if (baseName) {
      if (!classesByBaseName[baseName]) {
        classesByBaseName[baseName] = [];
      }
      classesByBaseName[baseName].push(cls);
    }

    addClassAlias(lookup, cls.displayName, cls._id);
    if (!classStream || normalizedName !== baseName) {
      addClassAlias(lookup, cls.name, cls._id);
    }

    if (cls.stream) {
      addClassAlias(lookup, `${cls.name}${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.name} ${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.displayName}${cls.stream}`, cls._id);
      addClassAlias(lookup, `${cls.displayName} ${cls.stream}`, cls._id);
    }
  });

  return { lookup, byId, classesByBaseName };
};

const findUnstreamedClass = (classes) =>
  (classes || []).find((cls) => !getClassStream(cls));

const findClassByStream = (classes, stream) =>
  (classes || []).find((cls) => getClassStream(cls) === stream);

const resolveClassTarget = ({ targetLabel, classLookup, classesByBaseName }) => {
  const normalizedTarget = normalizeClassLabel(targetLabel);
  const directTargetId = classLookup[normalizedTarget];
  if (directTargetId) {
    return directTargetId;
  }

  const { baseName, stream } = parseClassLabel(targetLabel);
  const candidates = classesByBaseName[baseName] || [];
  if (candidates.length === 0) {
    return null;
  }

  if (stream) {
    const matchingStreamClass = findClassByStream(candidates, stream);
    if (matchingStreamClass) {
      return matchingStreamClass._id;
    }
  }

  const unstreamedClass = findUnstreamedClass(candidates);
  if (unstreamedClass) {
    return unstreamedClass._id;
  }

  return candidates.length === 1 ? candidates[0]._id : null;
};

const resolveNextClassTarget = ({ currentClass, classesByBaseName }) => {
  const expectedNextClassName = getExpectedNextClassName(currentClass);
  if (!expectedNextClassName) {
    return null;
  }

  const candidates = classesByBaseName[normalizeClassLabel(expectedNextClassName)] || [];
  if (candidates.length === 0) {
    return null;
  }

  const currentStream = getClassStream(currentClass);
  if (currentStream) {
    const matchingStreamClass = findClassByStream(candidates, currentStream);
    if (matchingStreamClass) {
      return matchingStreamClass._id;
    }
  }

  const unstreamedClass = findUnstreamedClass(candidates);
  if (unstreamedClass) {
    return unstreamedClass._id;
  }

  return candidates.length === 1 ? candidates[0]._id : null;
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
  const { fromYear, toYear, fromTerm, classId, students, promoteAllClasses, ignoreReportCardRepeats = true } = req.body;
  const isAllClassPromotion = promoteAllClasses === true;

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

    const {
      lookup: classLookup,
      byId: classById,
      classesByBaseName,
    } = buildClassLookup(allClasses);

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

    else if (isAllClassPromotion) {
      const classIds = allClasses.map((cls) => cls._id);

      studentsToMigrate = await Student.find({
        school: schoolId,
        class: { $in: classIds },
        academicYear: { $in: fromYearVariants },
        status: { $ne: "graduated" }
      })
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
        message: 'Provide classId, students[], or promoteAllClasses.'
      });
    }

    if (studentsToMigrate.length === 0) {
      console.log('[Student Promotion] No eligible students found', {
        schoolId: String(schoolId),
        classId,
        promoteAllClasses: isAllClassPromotion,
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
    let manualPlacementCount = 0;
    let skippedNoReportCardPromotionCount = 0;
    let skippedUnresolvedReportTargetCount = 0;
    let skippedMissingNextClassCount = 0;
    const unresolvedReportTargets = [];
    const missingNextClassTargets = [];

    const reportPromotionsByClass = {};
    const sourceTermsByClass = {};

    if (isAllClassPromotion) {
      await Promise.all(allClasses.map(async (cls) => {
        const classKey = String(cls._id);
        const data = await getReportCardPromotions({
          schoolId,
          classId: cls._id,
          fromYear,
          fromTerm
        });

        reportPromotionsByClass[classKey] = data.promotions || {};
        if (data.sourceTerm) {
          sourceTermsByClass[classKey] = data.sourceTerm;
        }
      }));
    } else if (classId) {
      const reportCardPromotionData = await getReportCardPromotions({
        schoolId,
        classId,
        fromYear,
        fromTerm
      });
      reportPromotionsByClass[String(classId)] = reportCardPromotionData.promotions || {};
      if (reportCardPromotionData.sourceTerm) {
        sourceTermsByClass[String(classId)] = reportCardPromotionData.sourceTerm;
      }
    }

    const reportCardPromotionEntries = Object.values(reportPromotionsByClass)
      .reduce((total, promotions) => total + Object.keys(promotions || {}).length, 0);

    // Build quick lookups for individual migration settings
    const promoteMap = {};
    const manualTargetMap = {};
    const invalidManualTargets = [];
    if (Array.isArray(students)) {
      students.forEach(s => {
        promoteMap[s.studentId] = s.promote !== false; // default true
        if (s.targetClassId) {
          if (classById[String(s.targetClassId)]) {
            manualTargetMap[s.studentId] = String(s.targetClassId);
          } else {
            invalidManualTargets.push({
              studentId: String(s.studentId || ''),
              targetClassId: String(s.targetClassId),
            });
          }
        }
      });
    }

    if (invalidManualTargets.length > 0) {
      return res.status(400).json({
        message: 'One or more selected destination classes could not be found for this school.',
        invalidManualTargets,
      });
    }

    // ------------------------------------------------------------
    // 4. PROCESS EACH STUDENT IN MEMORY (FAST)
    // ------------------------------------------------------------
    for (const student of studentsToMigrate) {
      const promote = Array.isArray(students)
        ? promoteMap[student._id] !== false
        : true;
      const manualTargetClassId = Array.isArray(students)
        ? manualTargetMap[String(student._id)]
        : null;

      const currentClassId = String(student.class);
      const currentClass = classById[currentClassId];
      const nextClassId = resolveNextClassTarget({
        currentClass,
        classesByBaseName,
      });
      const expectedNextClassName = getExpectedNextClassName(currentClass);
      const reportPromotions = reportPromotionsByClass[currentClassId] || {};
      const reportPromotedTo =
        reportPromotions[String(student._id)] ||
        reportPromotions[String(student.user)] ||
        '';

      let newClassId = currentClassId;
      let shouldGraduate = false;

      if (promote && manualTargetClassId) {
        newClassId = manualTargetClassId;
        manualPlacementCount++;
      } else if (promote && reportPromotedTo) {
        if (isRepeatedReportValue(reportPromotedTo, currentClass)) {
          if (ignoreReportCardRepeats !== false) {
            // Admin requested to promote regardless of report-card repeat remarks
            if (nextClassId) {
              newClassId = nextClassId;
              fallbackPromotionCount++;
            } else if (isGraduationClass(currentClass)) {
              shouldGraduate = true;
            } else {
              missingNextClassTargets.push({
                studentId: String(student._id),
                currentClass: currentClass?.displayName || currentClass?.name || currentClassId,
                expectedNextClass: expectedNextClassName,
              });
              skippedMissingNextClassCount++;
              continue;
            }
          } else {
            newClassId = currentClassId;
            reportCardRepeatCount++;
          }
        } else {
          const reportTargetClassId = resolveClassTarget({
            targetLabel: reportPromotedTo,
            classLookup,
            classesByBaseName,
          });
          if (reportTargetClassId) {
            newClassId = reportTargetClassId;
            reportCardPromotionCount++;
          } else if (ignoreReportCardRepeats !== false && nextClassId) {
            newClassId = nextClassId;
            fallbackPromotionCount++;
          } else {
            unresolvedReportTargets.push({
              studentId: String(student._id),
              promotedTo: reportPromotedTo,
            });
            skippedUnresolvedReportTargetCount++;
            continue;
          }
        }
      } else if (isAllClassPromotion) {
        skippedNoReportCardPromotionCount++;
        continue;
      } else if (promote && nextClassId) {
        newClassId = nextClassId;
        fallbackPromotionCount++;
      } else if (promote && !nextClassId) {
        if (isGraduationClass(currentClass)) {
          shouldGraduate = true;
        } else {
          missingNextClassTargets.push({
            studentId: String(student._id),
            currentClass: currentClass?.displayName || currentClass?.name || currentClassId,
            expectedNextClass: expectedNextClassName,
          });
          skippedMissingNextClassCount++;
          continue;
        }
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
      promoteAllClasses: isAllClassPromotion,
      sourceTermCount: Object.keys(sourceTermsByClass).length,
      eligibleStudents: studentsToMigrate.length,
      migratedCount,
      graduatedCount,
      reportCardPromotionCount,
      reportCardRepeatCount,
      fallbackPromotionCount,
      manualPlacementCount,
      skippedNoReportCardPromotionCount,
      skippedUnresolvedReportTargetCount,
      skippedMissingNextClassCount,
      unresolvedReportTargetCount: unresolvedReportTargets.length,
      missingNextClassTargetCount: missingNextClassTargets.length,
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
      promoteAllClasses: isAllClassPromotion,
      sourceTerms: Object.values(sourceTermsByClass).map((term) => ({
        id: String(term._id),
        term: term.term,
        academicYear: term.academicYear,
      })),
      sourceTerm: Object.values(sourceTermsByClass)[0]
        ? {
            id: String(Object.values(sourceTermsByClass)[0]._id),
            term: Object.values(sourceTermsByClass)[0].term,
            academicYear: Object.values(sourceTermsByClass)[0].academicYear,
          }
        : null,
      reportCardPromotionEntries,
      reportCardPromotionsApplied: reportCardPromotionCount,
      reportCardRepeatsApplied: reportCardRepeatCount,
      fallbackPromotionsApplied: fallbackPromotionCount,
      manualPlacementsApplied: manualPlacementCount,
      skippedNoReportCardPromotion: skippedNoReportCardPromotionCount,
      skippedUnresolvedReportTarget: skippedUnresolvedReportTargetCount,
      skippedMissingNextClass: skippedMissingNextClassCount,
      unresolvedReportTargets,
      missingNextClassTargets,
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
