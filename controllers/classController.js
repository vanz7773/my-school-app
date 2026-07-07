const mongoose = require('mongoose');
const Class = require('../models/Class');
const User = require('../models/User');
const School = require('../models/School');
const Teacher = require('../models/Teacher');
const Subject = require('../models/Subject');
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
      .populate('students', 'name email')
      .populate('subjects', 'name code')
      .sort({ name: 1, stream: 1 });

    res.status(200).json({ success: true, classes });
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
