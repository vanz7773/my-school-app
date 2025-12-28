const Class = require('../models/Class');
const User = require('../models/User');
const School = require('../models/School');
const Teacher = require('../models/Teacher');
// ✅ Create class (admin only)
exports.createClass = async (req, res) => {
  try {
    const { name, stream, teachers } = req.body;
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
    });

    await newClass.save();

    // ✅ Populate before returning
    const populatedClass = await Class.findById(newClass._id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('students', 'name email');

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
      .populate('students', 'name email')
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
    const { teacherId } = req.params; // 👉 Teacher._id
    const schoolId = req.user.school;

    // 1️⃣ Find teacher profile
    const teacherProfile = await Teacher.findOne({
      _id: teacherId,
      school: schoolId
    }).lean();

    if (!teacherProfile) {
      return res.status(404).json({ message: 'Teacher profile not found' });
    }

    // 2️⃣ Resolve USER ID (this is what Class uses)
    const userId = teacherProfile.user;

    // 3️⃣ Fetch classes (subject + class teacher)
    const classes = await Class.find({
      school: schoolId,
      $or: [
        { teachers: userId },
        { classTeacher: userId }
      ]
    })
      .select('_id name stream displayName classTeacher')
      .sort({ name: 1, stream: 1 })
      .lean();

    // 4️⃣ Normalize for frontend
    const normalized = classes.map(cls => ({
      ...cls,
      className: cls.name,
      classDisplayName:
        cls.displayName ||
        (cls.stream ? `${cls.name}${cls.stream}` : cls.name),
    }));

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
    const { name, stream, teachers } = req.body;
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

    await classToUpdate.save();

    // ✅ Populate before returning
    const updatedClass = await Class.findById(id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('students', 'name email');

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
    const { teacherId } = req.body;
    const schoolId = req.user.school;

    const classDoc = await Class.findOne({ _id: classId, school: schoolId });
    if (!classDoc) {
      return res.status(404).json({ message: 'Class not found' });
    }

    const teacher = await User.findOne({
      _id: teacherId,
      role: 'teacher',
      school: schoolId
    });

    if (!teacher) {
      return res.status(400).json({ message: 'Teacher not found in your school' });
    }

    // 🔥 AUTO-REMOVE teacher from previous class
    const previousClass = await Class.findOne({
      school: schoolId,
      classTeacher: teacherId,
      _id: { $ne: classId }
    });

    if (previousClass) {
      previousClass.classTeacher = null;
      await previousClass.save();
    }

    classDoc.classTeacher = teacherId;
    await classDoc.save();

    const updatedClass = await Class.findById(classDoc._id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('students', 'name email');

    res.status(200).json({
      success: true,
      message: previousClass
        ? `Teacher moved from ${previousClass.displayName || previousClass.name} to ${classDoc.displayName || classDoc.name}`
        : 'Class teacher assigned successfully',
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
