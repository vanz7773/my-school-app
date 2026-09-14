const mongoose = require('mongoose');
const Class = require('../models/Class');
const User = require('../models/User');
const School = require('../models/School');
const Teacher = require('../models/Teacher');
const Subject = require('../models/Subject');
const Student = require('../models/Student');
// ✅ Create class (admin only)
exports.createClass = async (req, res) => {
  try {
    const { name, stream, teachers, subjects } = req.body;
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const school = await School.findById(schoolId);
    if (!school) {
      return res.status(400).json({ message: 'School not found' });
    }

    // ✅ UPDATED uniqueness check (school + name + stream)
    const existing = await Class.findOne({
      school: schoolId,
      name,
      stream: stream || null
    });

    if (existing) {
      return res.status(400).json({
        message: stream
          ? `Class ${name}${stream} already exists in your school`
          : `Class ${name} already exists in your school`
      });
    }

    let validTeachers = [];
    if (teachers && Array.isArray(teachers)) {
      const foundTeachers = await User.find({
        _id: { $in: teachers },
        role: 'teacher',
        school: schoolId,
      });

      if (foundTeachers.length !== teachers.length) {
        return res.status(400).json({
          message: 'Some teacher IDs are invalid or not from your school'
        });
      }

      validTeachers = foundTeachers.map(t => t._id);
    }

    const newClass = new Class({
      name,
      stream: stream || null,
      displayName: stream ? `${name}${stream}` : name,
      school: schoolId,
      teachers: validTeachers,
      classTeacher: null,
      subjects: Array.isArray(subjects) ? subjects : [],
    });

    await newClass.save();

    // ✅ Populate before returning
    const populatedClass = await Class.findById(newClass._id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('students', 'name email')
      .populate('subjects', 'name code');

    res.status(201).json({
      message: 'Class created successfully',
      class: populatedClass,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error creating class',
      error: err.message
    });
  }
};

// ✅ Get all classes for a school (admin only)
exports.getAllClasses = async (req, res) => {
  try {
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(403).json({ message: 'Unauthorized: No school context' });
    }

    const classes = await Class.find({ school: schoolId })
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('subjects', 'name code')
      .sort({ name: 1, stream: 1 })
      .lean();

    const classIds = classes.map((classDoc) => classDoc._id);
    const classStudents = await Student.find({
      school: schoolId,
      class: { $in: classIds },
      status: { $ne: 'graduated' },
    })
      .select('class user')
      .populate('user', 'name email')
      .lean();

    const studentsByClass = {};
    classStudents.forEach((student) => {
      const classId = String(student.class || '');
      if (!classId || !student.user) return;
      if (!studentsByClass[classId]) studentsByClass[classId] = [];
      studentsByClass[classId].push(student.user);
    });

    const classesWithCurrentStudents = classes.map((classDoc) => ({
      ...classDoc,
      students: studentsByClass[String(classDoc._id)] || [],
    }));

    res.status(200).json({ success: true, classes: classesWithCurrentStudents });
  } catch (err) {
    res.status(500).json({
      message: 'Error fetching classes',
      error: err.message
    });
  }
};

// ✅ Get classes assigned to a teacher (teacher only)
exports.getTeacherClasses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    const schoolId = req.user.school;

    let userId;
    let assignedClassIds = [];

    // 1️⃣ If ID belongs to Teacher collection
    const teacherDoc = await Teacher.findOne({
      _id: teacherId,
      school: schoolId
    }).lean();

    if (teacherDoc) {
      // Teacher._id ➜ User._id
      userId = teacherDoc.user;
      assignedClassIds = teacherDoc.assignedClasses || [];
    } else {
      // 2️⃣ Fallback: ID is already User._id
      const user = await User.findOne({
        _id: teacherId,
        role: 'teacher',
        school: schoolId
      }).lean();

      if (!user) {
        return res.status(404).json({ message: 'Teacher not found' });
      }

      userId = user._id;
      const teacherByUserId = await Teacher.findOne({ user: userId, school: schoolId }).lean();
      assignedClassIds = teacherByUserId?.assignedClasses || [];
    }

    // 3️⃣ Fetch classes using USER ID or assignedClassIds
    const classes = await Class.find({
      school: schoolId,
      $or: [
        { teachers: userId },
        { classTeacher: userId },
        { coClassTeacher: userId },
        { _id: { $in: assignedClassIds } }
      ]
    })
      .populate('subjects', 'name code')
      .select('_id name stream displayName classTeacher coClassTeacher subjects')
      .sort({ name: 1, stream: 1 })
      .lean();

    // 4️⃣ Normalize
    const normalized = classes.map(cls => {
  const name = cls.name || "Unknown Class";
  const stream = cls.stream || null;

  return {
    ...cls,
    name,
    stream,
    classDisplayName:
      cls.displayName ||
      (stream ? `${name}${stream}` : name),
  };
});


    res.status(200).json({
      success: true,
      totalClasses: normalized.length,
      classes: normalized
    });
  } catch (err) {
    console.error('Error fetching teacher classes:', err);
    res.status(500).json({
      message: 'Error fetching teacher classes',
      error: err.message
    });
  }
};



// ✅ Update class (admin only)
exports.updateClass = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, stream, teachers, subjects } = req.body;
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const classToUpdate = await Class.findOne({ _id: id, school: schoolId });
    if (!classToUpdate) {
      return res.status(404).json({ message: 'Class not found or unauthorized' });
    }

    // ✅ UPDATED uniqueness logic (handles name OR stream change)
    if (name !== undefined || stream !== undefined) {
      const nextName = name ?? classToUpdate.name;
      const nextStream = stream ?? classToUpdate.stream ?? null;

      const existingClass = await Class.findOne({
        school: schoolId,
        name: nextName,
        stream: nextStream,
        _id: { $ne: id }
      });

      if (existingClass) {
        return res.status(400).json({
          message: nextStream
            ? `Class ${nextName}${nextStream} already exists in your school`
            : `Class ${nextName} already exists in your school`
        });
      }

      classToUpdate.name = nextName;
      classToUpdate.stream = nextStream;
      classToUpdate.displayName = nextStream
        ? `${nextName}${nextStream}`
        : nextName;
    }

    if (teachers && Array.isArray(teachers)) {
      const foundTeachers = await User.find({
        _id: { $in: teachers },
        role: 'teacher',
        school: schoolId
      });

      if (foundTeachers.length !== teachers.length) {
        return res.status(400).json({
          message: 'Some teacher IDs are invalid or not from your school'
        });
      }

      classToUpdate.teachers = foundTeachers.map(t => t._id);
    }

    if (subjects !== undefined) {
      classToUpdate.subjects = Array.isArray(subjects) ? subjects : [];
    }

    await classToUpdate.save();

    // ✅ Populate before returning
    const updatedClass = await Class.findById(id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('students', 'name email')
      .populate('subjects', 'name code');

    res.status(200).json({
      message: 'Class updated successfully',
      class: updatedClass,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Error updating class',
      error: err.message
    });
  }
};

// ✅ Bulk add subjects to multiple classes (admin only)
exports.bulkAddSubjectsToClasses = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const { classIds, subjects, subjectIds } = req.body;

    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const nextClassIds = Array.from(
      new Set((Array.isArray(classIds) ? classIds : []).map((id) => String(id).trim()).filter(Boolean))
    );
    const nextSubjectIds = Array.from(
      new Set((Array.isArray(subjects || subjectIds) ? (subjects || subjectIds) : []).map((id) => String(id).trim()).filter(Boolean))
    );

    if (nextClassIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one class.' });
    }

    if (nextSubjectIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one subject.' });
    }

    const invalidClassId = nextClassIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidClassId) {
      return res.status(400).json({ message: 'One or more selected classes are invalid.' });
    }

    const invalidSubjectId = nextSubjectIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidSubjectId) {
      return res.status(400).json({ message: 'One or more selected subjects are invalid.' });
    }

    const classCount = await Class.countDocuments({
      _id: { $in: nextClassIds },
      school: schoolId,
    });

    if (classCount !== nextClassIds.length) {
      return res.status(400).json({
        message: 'One or more selected classes are invalid or not in your school.',
      });
    }

    const subjectCount = await Subject.countDocuments({
      _id: { $in: nextSubjectIds },
    });

    if (subjectCount !== nextSubjectIds.length) {
      return res.status(400).json({ message: 'One or more selected subjects are invalid.' });
    }

    const result = await Class.updateMany(
      { _id: { $in: nextClassIds }, school: schoolId },
      { $addToSet: { subjects: { $each: nextSubjectIds } } }
    );

    const updatedClasses = await Class.find({ _id: { $in: nextClassIds }, school: schoolId })
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('students', 'name email')
      .populate('subjects', 'name code shortName')
      .sort({ name: 1, stream: 1 });

    return res.status(200).json({
      success: true,
      message: `Subjects added to ${nextClassIds.length} class${nextClassIds.length === 1 ? '' : 'es'}.`,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      classes: updatedClasses,
    });
  } catch (err) {
    console.error('Error bulk adding subjects to classes:', err);
    return res.status(500).json({
      message: 'Error adding subjects to classes',
      error: err.message,
    });
  }
};

// ✅ Delete class (admin only)
exports.deleteClass = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;

    const found = await Class.findOne({ _id: id, school: schoolId });
    if (!found) {
      return res.status(404).json({ message: 'Class not found or unauthorized' });
    }

    await Class.findByIdAndDelete(id);
    res.json({ message: 'Class deleted' });
  } catch (err) {
    res.status(500).json({
      message: 'Error deleting class',
      error: err.message
    });
  }
};

// ✅ Assign or change class teacher (admin only)
exports.assignClassTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    const { teacherId, isCoTeacher } = req.body; // isCoTeacher is a boolean flag
    const schoolId = req.user.school;

    if (classId === 'none') {
      // Global unassign for this teacher
      if (teacherId && teacherId !== 'none') {
        const query = isCoTeacher ? { coClassTeacher: teacherId } : { classTeacher: teacherId };
        const update = isCoTeacher ? { coClassTeacher: null } : { classTeacher: null };
        
        await Class.updateMany({ school: schoolId, ...query }, update);
        return res.status(200).json({
          success: true,
          message: `Teacher unassigned from ${isCoTeacher ? 'all Co-Class Teacher' : 'all Primary Class Teacher'} roles.`,
          class: null
        });
      }
      return res.status(400).json({ message: 'Teacher ID required to unassign.' });
    }

    const classDoc = await Class.findOne({ _id: classId, school: schoolId });
    if (!classDoc) {
      return res.status(404).json({ message: 'Class not found' });
    }

    let previousClassMessage = null;

    if (teacherId === 'none') {
      if (isCoTeacher) {
        classDoc.coClassTeacher = null;
      } else {
        classDoc.classTeacher = null;
      }
    } else {
      const teacher = await User.findOne({
        _id: teacherId,
        role: 'teacher',
        school: schoolId
      });

      if (!teacher) {
        return res.status(400).json({ message: 'Teacher not found in your school' });
      }

      if (isCoTeacher) {
        // Teacher cannot be both Primary and Co-Teacher in the SAME class
        if (String(classDoc.classTeacher) === String(teacherId)) {
          classDoc.classTeacher = null; // Removing from primary role
        }

        classDoc.coClassTeacher = teacherId;
      } else {
        // Teacher cannot be both Primary and Co-Teacher in the SAME class
        if (String(classDoc.coClassTeacher) === String(teacherId)) {
          classDoc.coClassTeacher = null; // Removing from co-teacher role
        }

        classDoc.classTeacher = teacherId;
      }
    }

    await classDoc.save();

    const updatedClass = await Class.findById(classDoc._id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('students', 'name email');

    res.status(200).json({
      success: true,
      message: previousClassMessage || (isCoTeacher ? 'Co-Class Teacher assigned successfully' : 'Primary Class Teacher assigned successfully'),
      class: updatedClass
    });
  } catch (err) {
    console.error('Error assigning class teacher:', err);
    res.status(500).json({
      success: false,
      message: 'Error assigning class teacher',
      error: err.message
    });
  }
};


// ✅ Merge multiple stream classes into a single target class (admin only)
exports.mergeStreams = async (req, res) => {
  try {
    const schoolId = req.user.school;
    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const {
      sourceClassIds,
      targetClassId,
      targetClassName,
      targetClassStream = null,
      deleteSourceClasses = true,
    } = req.body;

    if (!Array.isArray(sourceClassIds) || sourceClassIds.length === 0) {
      return res.status(400).json({ message: 'Please select at least one source stream class to merge.' });
    }

    // Clean and validate source IDs
    const cleanSourceIds = Array.from(
      new Set(sourceClassIds.map((id) => String(id).trim()).filter(Boolean))
    );

    for (const id of cleanSourceIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: `Invalid source class ID: ${id}` });
      }
    }

    // Verify all source classes exist and belong to this school
    const sourceClasses = await Class.find({
      _id: { $in: cleanSourceIds },
      school: schoolId,
    });

    if (sourceClasses.length !== cleanSourceIds.length) {
      return res.status(400).json({
        message: 'One or more source classes were not found in your school.',
      });
    }

    // Determine target class
    let targetClass = null;

    if (targetClassId) {
      if (!mongoose.Types.ObjectId.isValid(targetClassId)) {
        return res.status(400).json({ message: 'Invalid target class ID provided.' });
      }

      if (cleanSourceIds.includes(String(targetClassId))) {
        return res.status(400).json({
          message: 'Target class cannot be one of the source classes being merged.',
        });
      }

      targetClass = await Class.findOne({ _id: targetClassId, school: schoolId });
      if (!targetClass) {
        return res.status(404).json({ message: 'Target class not found in your school.' });
      }
    } else {
      // Find or create target class based on name and stream
      const finalTargetName = String(targetClassName || sourceClasses[0].name).trim();
      const finalTargetStream =
        targetClassStream && String(targetClassStream).trim() !== ''
          ? String(targetClassStream).trim().toUpperCase()
          : null;

      if (!finalTargetName) {
        return res.status(400).json({ message: 'Target class name is required.' });
      }

      // Check if target class already exists
      targetClass = await Class.findOne({
        school: schoolId,
        name: finalTargetName,
        stream: finalTargetStream,
      });

      if (targetClass && cleanSourceIds.includes(String(targetClass._id))) {
        return res.status(400).json({
          message:
            'The target class already exists as one of the selected source classes. Please uncheck it from the source streams or select an alternative target.',
        });
      }

      if (!targetClass) {
        targetClass = new Class({
          name: finalTargetName,
          stream: finalTargetStream,
          displayName: finalTargetStream
            ? `${finalTargetName}${finalTargetStream}`
            : finalTargetName,
          school: schoolId,
          teachers: [],
          subjects: [],
          students: [],
          classTeacher: null,
          coClassTeacher: null,
        });
        await targetClass.save();
      }
    }

    const targetId = targetClass._id;

    // 1. Reassign Students in Student collection
    const studentsToMove = await Student.find({
      school: schoolId,
      class: { $in: cleanSourceIds },
    }).select('_id user');

    const studentIds = studentsToMove.map((s) => s._id);
    const studentUserIds = studentsToMove.map((s) => s.user).filter(Boolean);

    if (studentIds.length > 0) {
      await Student.updateMany(
        { _id: { $in: studentIds } },
        { $set: { class: targetId } }
      );
    }

    // Add student User IDs to targetClass.students array
    if (studentUserIds.length > 0) {
      await Class.findByIdAndUpdate(targetId, {
        $addToSet: { students: { $each: studentUserIds } },
      });
    }

    // 2. Consolidate Teachers, Subjects, and Class Teachers
    const allSourceTeachers = [];
    const allSourceSubjects = [];
    let candidateClassTeacher = null;
    let candidateCoClassTeacher = null;

    for (const src of sourceClasses) {
      if (Array.isArray(src.teachers)) {
        allSourceTeachers.push(...src.teachers);
      }
      if (Array.isArray(src.subjects)) {
        allSourceSubjects.push(...src.subjects);
      }
      if (!candidateClassTeacher && src.classTeacher) {
        candidateClassTeacher = src.classTeacher;
      }
      if (!candidateCoClassTeacher && src.coClassTeacher) {
        candidateCoClassTeacher = src.coClassTeacher;
      }
    }

    const updateFields = {};
    if (allSourceTeachers.length > 0) {
      updateFields.$addToSet = updateFields.$addToSet || {};
      updateFields.$addToSet.teachers = { $each: allSourceTeachers };
    }
    if (allSourceSubjects.length > 0) {
      updateFields.$addToSet = updateFields.$addToSet || {};
      updateFields.$addToSet.subjects = { $each: allSourceSubjects };
    }

    const setFields = {};
    if (!targetClass.classTeacher && candidateClassTeacher) {
      setFields.classTeacher = candidateClassTeacher;
    }
    if (
      !targetClass.coClassTeacher &&
      candidateCoClassTeacher &&
      String(candidateCoClassTeacher) !== String(targetClass.classTeacher || candidateClassTeacher)
    ) {
      setFields.coClassTeacher = candidateCoClassTeacher;
    }
    if (Object.keys(setFields).length > 0) {
      updateFields.$set = setFields;
    }

    if (Object.keys(updateFields).length > 0) {
      await Class.findByIdAndUpdate(targetId, updateFields);
    }

    // 3. Update Teacher model assignedClasses
    try {
      const TeacherModel = require('../models/Teacher');
      await TeacherModel.updateMany(
        { school: schoolId, assignedClasses: { $in: cleanSourceIds } },
        { $pull: { assignedClasses: { $in: cleanSourceIds } } }
      );

      const refreshedTarget = await Class.findById(targetId).select('teachers');
      if (refreshedTarget?.teachers?.length > 0) {
        await TeacherModel.updateMany(
          { school: schoolId, user: { $in: refreshedTarget.teachers } },
          { $addToSet: { assignedClasses: targetId } }
        );
      }
    } catch (teacherErr) {
      console.warn('⚠️ Warning: Teacher assignedClasses update encountered an issue:', teacherErr.message);
    }

    // 4. Update Enrollments
    try {
      const EnrollmentModel = require('../models/enrollmentModel');
      await EnrollmentModel.updateMany(
        { school: schoolId, class: { $in: cleanSourceIds } },
        { $set: { class: targetId } }
      );
    } catch (enrollErr) {
      console.warn('⚠️ Warning: Enrollment update issue:', enrollErr.message);
    }

    // 5. Update StudentAttendance
    try {
      const AttendanceModel = require('../models/StudentAttendance');
      await AttendanceModel.updateMany(
        { school: schoolId, class: { $in: cleanSourceIds } },
        { $set: { class: targetId } }
      );
    } catch (attErr) {
      console.warn('⚠️ Warning: StudentAttendance update issue:', attErr.message);
    }

    // 6. Update SbaRecord (handle unique index: { school, class, term, subject })
    try {
      const SbaRecordModel = require('../models/SbaRecord');
      const sourceSbas = await SbaRecordModel.find({
        school: schoolId,
        class: { $in: cleanSourceIds },
      });

      for (const srcSba of sourceSbas) {
        const existingTargetSba = await SbaRecordModel.findOne({
          school: schoolId,
          class: targetId,
          term: srcSba.term,
          subject: srcSba.subject,
        });

        if (existingTargetSba) {
          const existingMap = new Set(
            existingTargetSba.records.map((r) => String(r.student || ''))
          );
          for (const rec of srcSba.records || []) {
            if (rec.student && !existingMap.has(String(rec.student))) {
              existingTargetSba.records.push(rec);
            }
          }
          await existingTargetSba.save();
          await SbaRecordModel.findByIdAndDelete(srcSba._id);
        } else {
          srcSba.class = targetId;
          await srcSba.save();
        }
      }
    } catch (sbaErr) {
      console.warn('⚠️ Warning: SbaRecord update issue:', sbaErr.message);
    }

    // 7. Update ClassFeeRecord (handle unique index: { school, classId, termId, week })
    try {
      const ClassFeeRecordModel = require('../models/ClassFeeRecord');
      const sourceFeeRecords = await ClassFeeRecordModel.find({
        school: schoolId,
        classId: { $in: cleanSourceIds },
      });

      for (const srcFee of sourceFeeRecords) {
        const existingTargetFee = await ClassFeeRecordModel.findOne({
          school: schoolId,
          classId: targetId,
          termId: srcFee.termId,
          week: srcFee.week,
        });

        if (existingTargetFee) {
          const existingStudentIds = new Set(
            existingTargetFee.breakdown.map((b) => String(b.student || ''))
          );
          for (const b of srcFee.breakdown || []) {
            if (b.student && !existingStudentIds.has(String(b.student))) {
              existingTargetFee.breakdown.push(b);
            }
          }
          await existingTargetFee.save();
          await ClassFeeRecordModel.findByIdAndDelete(srcFee._id);
        } else {
          srcFee.classId = targetId;
          await srcFee.save();
        }
      }
    } catch (classFeeErr) {
      console.warn('⚠️ Warning: ClassFeeRecord update issue:', classFeeErr.message);
    }

    // 8. Update FeedingFeeRecord (handle unique index: { school, classId, termId, week })
    try {
      const FeedingFeeRecordModel = require('../models/FeedingFeeRecord');
      const sourceFeedingRecords = await FeedingFeeRecordModel.find({
        school: schoolId,
        classId: { $in: cleanSourceIds },
      });

      for (const srcFeed of sourceFeedingRecords) {
        const existingTargetFeeding = await FeedingFeeRecordModel.findOne({
          school: schoolId,
          classId: targetId,
          termId: srcFeed.termId,
          week: srcFeed.week,
        });

        if (existingTargetFeeding) {
          const existingStudentIds = new Set(
            existingTargetFeeding.breakdown.map((b) => String(b.student || ''))
          );
          for (const b of srcFeed.breakdown || []) {
            if (b.student && !existingStudentIds.has(String(b.student))) {
              existingTargetFeeding.breakdown.push(b);
            }
          }
          await existingTargetFeeding.save();
          await FeedingFeeRecordModel.findByIdAndDelete(srcFeed._id);
        } else {
          srcFeed.classId = targetId;
          await srcFeed.save();
        }
      }
    } catch (feedingErr) {
      console.warn('⚠️ Warning: FeedingFeeRecord update issue:', feedingErr.message);
    }

    // 9. Update Timetable, Assignment, WeeklyExercise, Grade, Announcement, QuizSession, AgendaEvent
    const simpleClassModels = [
      { model: '../models/Timetable', field: 'class' },
      { model: '../models/Assignment', field: 'class' },
      { model: '../models/WeeklyExercise', field: 'class' },
      { model: '../models/Grade', field: 'class' },
      { model: '../models/Announcement', field: 'class' },
      { model: '../models/QuizSession', field: 'class' },
      { model: '../models/AgendaEvent', field: 'class' },
    ];

    for (const item of simpleClassModels) {
      try {
        const M = require(item.model);
        await M.updateMany(
          { school: schoolId, [item.field]: { $in: cleanSourceIds } },
          { $set: { [item.field]: targetId } }
        );
      } catch (err) {
        // Model might not exist or field optional
      }
    }

    // 10. Delete or clear source classes
    if (deleteSourceClasses) {
      await Class.deleteMany({
        _id: { $in: cleanSourceIds },
        school: schoolId,
      });
    } else {
      await Class.updateMany(
        { _id: { $in: cleanSourceIds }, school: schoolId },
        { $set: { students: [] } }
      );
    }

    // Return updated populated target class
    const populatedTargetClass = await Class.findById(targetId)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('coClassTeacher', 'name email')
      .populate('students', 'name email')
      .populate('subjects', 'name code shortName');

    return res.status(200).json({
      success: true,
      message: `Successfully merged ${cleanSourceIds.length} stream${
        cleanSourceIds.length === 1 ? '' : 's'
      } into ${populatedTargetClass.displayName || populatedTargetClass.name}. Moved ${
        studentIds.length
      } student${studentIds.length === 1 ? '' : 's'}.`,
      mergedCount: cleanSourceIds.length,
      studentsMoved: studentIds.length,
      targetClass: populatedTargetClass,
    });
  } catch (err) {
    console.error('Error merging streams:', err);
    return res.status(500).json({
      message: 'Failed to merge streams',
      error: err.message,
    });
  }
};
