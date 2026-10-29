const Class = require('../models/Class');
const Student = require('../models/Student');
const Term = require('../models/term');
const StudentAttendance = require('../models/StudentAttendance');
const SbaRecord = require('../models/SbaRecord');
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const ClassFeeRecord = require('../models/ClassFeeRecord');
const { TermBill } = require('../models/allModels');
const mongoose = require('mongoose');

// --------------------------------------------------------------------
// 🔍 Cache for enrollment data
// --------------------------------------------------------------------
const enrollmentCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

const idsEqual = (a, b) => String(a || '') === String(b || '');

const cloneSubdocument = (subdoc) => {
  const plain = subdoc?.toObject ? subdoc.toObject() : { ...(subdoc || {}) };
  delete plain._id;
  return plain;
};

const getActiveTerms = async (schoolId, session) => {
  const today = new Date();
  return Term.find({
    school: schoolId,
    startDate: { $lte: today },
    endDate: { $gte: today },
  })
    .session(session)
    .sort({ startDate: -1 })
    .lean();
};

const assertNoAttendanceConflicts = async ({
  schoolId,
  studentId,
  oldClassId,
  targetClassId,
  termIds,
  session,
}) => {
  const oldRecords = await StudentAttendance.find({
    school: schoolId,
    student: studentId,
    class: oldClassId,
    termId: { $in: termIds },
  })
    .session(session)
    .lean();

  for (const record of oldRecords) {
    const existing = await StudentAttendance.findOne({
      school: schoolId,
      student: studentId,
      class: targetClassId,
      termId: record.termId,
      weekNumber: record.weekNumber,
    })
      .session(session)
      .lean();

    if (existing) {
      throw Object.assign(
        new Error('This student already has attendance for the target class in the active term. Please review the duplicate target-class record first.'),
        { statusCode: 409 }
      );
    }
  }
};

const moveSbaRecords = async ({
  schoolId,
  studentId,
  oldClassId,
  targetClassId,
  termIds,
  session,
}) => {
  const oldRecords = await SbaRecord.find({
    school: schoolId,
    class: oldClassId,
    term: { $in: termIds },
    'records.student': studentId,
  }).session(session);

  let movedEntries = 0;

  for (const oldRecord of oldRecords) {
    const studentEntries = (oldRecord.records || [])
      .filter((entry) => idsEqual(entry.student, studentId))
      .map(cloneSubdocument);

    if (!studentEntries.length) continue;

    let targetRecord = await SbaRecord.findOne({
      school: schoolId,
      class: targetClassId,
      term: oldRecord.term,
      subject: oldRecord.subject,
    }).session(session);

    if (targetRecord?.records?.some((entry) => idsEqual(entry.student, studentId))) {
      throw Object.assign(
        new Error('This student already has marks in the target class for the active term. Please review the target-class marks first.'),
        { statusCode: 409 }
      );
    }

    if (!targetRecord) {
      targetRecord = new SbaRecord({
        school: schoolId,
        class: targetClassId,
        term: oldRecord.term,
        subject: oldRecord.subject,
        records: [],
      });
    }

    targetRecord.records.push(...studentEntries);
    oldRecord.records = oldRecord.records.filter(
      (entry) => !idsEqual(entry.student, studentId)
    );

    await targetRecord.save({ session });
    await oldRecord.save({ session });
    movedEntries += studentEntries.length;
  }

  return movedEntries;
};

const moveFeeBreakdownRecords = async ({
  Model,
  schoolId,
  studentId,
  oldClassId,
  targetClass,
  targetClassId,
  termIds,
  session,
}) => {
  const oldRecords = await Model.find({
    school: schoolId,
    classId: oldClassId,
    termId: { $in: termIds },
    'breakdown.student': studentId,
  }).session(session);

  const targetClassName = targetClass.displayName || targetClass.name || 'Class';
  let movedEntries = 0;

  for (const oldRecord of oldRecords) {
    const studentEntries = (oldRecord.breakdown || [])
      .filter((entry) => idsEqual(entry.student, studentId))
      .map((entry) => ({
        ...cloneSubdocument(entry),
        className: targetClassName,
      }));

    if (!studentEntries.length) continue;

    let targetRecord = await Model.findOne({
      school: schoolId,
      classId: targetClassId,
      termId: oldRecord.termId,
      week: oldRecord.week,
    }).session(session);

    if (targetRecord?.breakdown?.some((entry) => idsEqual(entry.student, studentId))) {
      throw Object.assign(
        new Error('This student already has fee records in the target class for the active term. Please review the target-class fee record first.'),
        { statusCode: 409 }
      );
    }

    if (!targetRecord) {
      targetRecord = new Model({
        school: schoolId,
        classId: targetClassId,
        termId: oldRecord.termId,
        week: oldRecord.week,
        classFeeAmount: oldRecord.classFeeAmount || 0,
        configType: oldRecord.configType || undefined,
        breakdown: [],
      });
    }

    targetRecord.breakdown.push(...studentEntries);
    oldRecord.breakdown = oldRecord.breakdown.filter(
      (entry) => !idsEqual(entry.student, studentId)
    );
    oldRecord.lastUpdatedAt = new Date();
    targetRecord.lastUpdatedAt = new Date();

    await targetRecord.save({ session });
    await oldRecord.save({ session });
    movedEntries += studentEntries.length;
  }

  return movedEntries;
};

// --------------------------------------------------------------------
// 📈 Get class enrollment summary (AGGREGATION - RECOMMENDED)
// --------------------------------------------------------------------
exports.getClassEnrollmentSummary = async (req, res) => {
  try {
    const schoolId = req.user.school;

    // Cache check
    const cacheKey = `enrollment_agg_${schoolId}`;
    const cached = enrollmentCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json(cached.data);
    }

    const aggregationResult = await Class.aggregate([
      // Match classes for current school
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId)
        }
      },

      // Sort by class name
      { $sort: { name: 1 } },

      // Lookup students for each class
      {
        $lookup: {
          from: 'students',
          let: { classId: '$_id' },
          pipeline: [
            {
              $match: {
                status: { $ne: 'graduated' },
                $expr: {
                  $and: [
                    { $eq: ['$class', '$$classId'] },
                    { $eq: ['$school', new mongoose.Types.ObjectId(schoolId)] }
                  ]
                }
              }
            },
            {
              $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'userInfo'
              }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            {
              $project: {
                gender: 1,
                dateOfBirth: 1,
                admissionNumber: 1,
                guardianPhone: 1,
                guardianPhone2: 1,
                guardianName: 1,
                guardianOccupation: 1,
                fatherName: 1,
                fatherOccupation: 1,
                motherName: 1,
                motherOccupation: 1,
                religion: 1,
                hometown: 1,
                languageSpoken: 1,
                academicYear: 1,
                profilePicture: 1,
                'userName': '$userInfo.name',
                'userEmail': '$userInfo.email'
              }
            }
          ],
          as: 'students'
        }
      },

      // Project final structure
      // Project final structure
      {
        $project: {
          classId: '$_id',

          // ✅ ADD THESE TWO LINES
          className: '$name',
          classDisplayName: { $ifNull: ['$displayName', '$name'] },

          boys: {
            $size: {
              $filter: {
                input: '$students',
                as: 'student',
                cond: { $eq: [{ $toLower: '$$student.gender' }, 'male'] }
              }
            }
          },
          girls: {
            $size: {
              $filter: {
                input: '$students',
                as: 'student',
                cond: { $eq: [{ $toLower: '$$student.gender' }, 'female'] }
              }
            }
          },
          total: {
            $add: [
              {
                $size: {
                  $filter: {
                    input: '$students',
                    as: 'student',
                    cond: { $eq: [{ $toLower: '$$student.gender' }, 'male'] }
                  }
                }
              },
              {
                $size: {
                  $filter: {
                    input: '$students',
                    as: 'student',
                    cond: { $eq: [{ $toLower: '$$student.gender' }, 'female'] }
                  }
                }
              }
            ]
          },
          students: {
            $map: {
              input: '$students',
              as: 'student',
              in: {
                _id: '$$student._id',
                name: { $ifNull: ['$$student.userName', 'Unnamed'] },
                profilePicture: '$$student.profilePicture',
                email: { $ifNull: ['$$student.userEmail', null] },
                dateOfBirth: '$$student.dateOfBirth',
                admissionNumber: '$$student.admissionNumber',
                gender: '$$student.gender',
                academicYear: '$$student.academicYear',
                guardianPhone: '$$student.guardianPhone',
                guardianPhone2: '$$student.guardianPhone2',
                guardianName: '$$student.guardianName',
                guardianOccupation: '$$student.guardianOccupation',
                fatherName: '$$student.fatherName',
                fatherOccupation: '$$student.fatherOccupation',
                motherName: '$$student.motherName',
                motherOccupation: '$$student.motherOccupation',
                religion: '$$student.religion',
                hometown: '$$student.hometown',
                languageSpoken: '$$student.languageSpoken'
              }
            }
          }
        }
      }
    ]);

    // Calculate school-wide summary
    const schoolSummary = {
      totalClasses: aggregationResult.length,
      totalStudents: aggregationResult.reduce((sum, cls) => sum + cls.total, 0),
      totalBoys: aggregationResult.reduce((sum, cls) => sum + cls.boys, 0),
      totalGirls: aggregationResult.reduce((sum, cls) => sum + cls.girls, 0)
    };

    const result = {
      success: true,
      summary: schoolSummary,
      classes: aggregationResult,
      timestamp: new Date().toISOString()
    };

    // Cache the result
    enrollmentCache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

  } catch (err) {
    console.error("❌ getClassEnrollmentSummary error:", err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment summary',
      error: err.message
    });
  }
};

// --------------------------------------------------------------------
// 🔁 Move one student to another class
// --------------------------------------------------------------------
exports.moveStudentToClass = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const schoolId = req.user.school;
    const { studentId } = req.params;
    const { classId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(classId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid student and class are required.',
      });
    }

    let resultPayload;

    await session.withTransaction(async () => {
      const [student, targetClass] = await Promise.all([
        Student.findOne({ _id: studentId, school: schoolId }).session(session),
        Class.findOne({ _id: classId, school: schoolId }).session(session),
      ]);

      if (!student) {
        throw Object.assign(new Error('Student not found.'), { statusCode: 404 });
      }

      if (!targetClass) {
        throw Object.assign(new Error('Target class not found.'), { statusCode: 404 });
      }

      const oldClassId = student.class || null;

      if (oldClassId && idsEqual(oldClassId, targetClass._id)) {
        resultPayload = {
          success: true,
          message: 'Student is already in the selected class.',
          summary: {
            studentUpdated: false,
            attendanceMoved: 0,
            sbaEntriesMoved: 0,
            feedingFeeEntriesMoved: 0,
            classFeeEntriesMoved: 0,
            termBillsUpdated: 0,
          },
        };
        return;
      }

      const activeTerms = await getActiveTerms(schoolId, session);
      const activeTermIds = activeTerms.map((term) => term._id);
      const activeTermPairs = activeTerms
        .filter((term) => term.term && term.academicYear)
        .map((term) => ({ term: term.term, academicYear: term.academicYear }));

      if (oldClassId && activeTermIds.length) {
        await assertNoAttendanceConflicts({
          schoolId,
          studentId: student._id,
          oldClassId,
          targetClassId: targetClass._id,
          termIds: activeTermIds,
          session,
        });
      }

      student.class = targetClass._id;
      student.status = 'active';
      await student.save({ session });

      await Promise.all([
        oldClassId
          ? Class.updateOne(
              { _id: oldClassId, school: schoolId },
              { $pull: { students: student.user } },
              { session }
            )
          : Promise.resolve(),
        Class.updateOne(
          { _id: targetClass._id, school: schoolId },
          { $addToSet: { students: student.user } },
          { session }
        ),
      ]);

      const attendanceResult =
        oldClassId && activeTermIds.length
          ? await StudentAttendance.updateMany(
              {
                school: schoolId,
                student: student._id,
                class: oldClassId,
                termId: { $in: activeTermIds },
              },
              { $set: { class: targetClass._id } },
              { session }
            )
          : { modifiedCount: 0 };

      const sbaEntriesMoved =
        oldClassId && activeTermIds.length
          ? await moveSbaRecords({
              schoolId,
              studentId: student._id,
              oldClassId,
              targetClassId: targetClass._id,
              termIds: activeTermIds,
              session,
            })
          : 0;

      const feedingFeeEntriesMoved =
        oldClassId && activeTermIds.length
          ? await moveFeeBreakdownRecords({
              Model: FeedingFeeRecord,
              schoolId,
              studentId: student._id,
              oldClassId,
              targetClass,
              targetClassId: targetClass._id,
              termIds: activeTermIds,
              session,
            })
          : 0;

      const classFeeEntriesMoved =
        oldClassId && activeTermIds.length
          ? await moveFeeBreakdownRecords({
              Model: ClassFeeRecord,
              schoolId,
              studentId: student._id,
              oldClassId,
              targetClass,
              targetClassId: targetClass._id,
              termIds: activeTermIds,
              session,
            })
          : 0;

      const termBillFilter = {
        school: schoolId,
        student: student._id,
        class: oldClassId,
      };

      if (activeTermPairs.length) {
        termBillFilter.$or = activeTermPairs.map((pair) => ({
          term: pair.term,
          academicYear: pair.academicYear,
        }));
      }

      const termBillsResult =
        oldClassId && activeTermPairs.length
          ? await TermBill.updateMany(
              termBillFilter,
              { $set: { class: targetClass._id } },
              { session }
            )
          : { modifiedCount: 0 };

      resultPayload = {
        success: true,
        message: `${student.name || 'Student'} moved to ${targetClass.displayName || targetClass.name}.`,
        targetClass: {
          _id: targetClass._id,
          name: targetClass.name,
          displayName: targetClass.displayName,
        },
        activeTerms: activeTerms.map((term) => ({
          _id: term._id,
          term: term.term,
          academicYear: term.academicYear,
        })),
        summary: {
          studentUpdated: true,
          attendanceMoved: attendanceResult.modifiedCount || 0,
          sbaEntriesMoved,
          feedingFeeEntriesMoved,
          classFeeEntriesMoved,
          termBillsUpdated: termBillsResult.modifiedCount || 0,
        },
      };
    });

    exports.clearEnrollmentCache(req.user.school);
    return res.json(resultPayload);
  } catch (err) {
    console.error('❌ moveStudentToClass error:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.statusCode
        ? err.message
        : 'Failed to move student to the selected class.',
      error: err.statusCode ? undefined : err.message,
    });
  } finally {
    session.endSession();
  }
};

// --------------------------------------------------------------------
// 🧹 Cache cleanup
// --------------------------------------------------------------------
exports.clearEnrollmentCache = (schoolId) => {
  if (schoolId) {
    enrollmentCache.delete(`enrollment_agg_${schoolId}`);
  } else {
    enrollmentCache.clear();
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of enrollmentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      enrollmentCache.delete(key);
    }
  }
}, CACHE_TTL);
