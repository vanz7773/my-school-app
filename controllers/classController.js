const Class = require('../models/Class');
const User = require('../models/User');
const School = require('../models/School');

// ✅ Create class (admin only)
exports.createClass = async (req, res) => {
  try {
    const { name, teachers } = req.body;
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const school = await School.findById(schoolId);
    if (!school) {
      return res.status(400).json({ message: 'School not found' });
    }

    const existing = await Class.findOne({ name, school: schoolId });
    if (existing) {
      return res.status(400).json({ message: 'Class with this name already exists in your school' });
    }

    let validTeachers = [];
    if (teachers && Array.isArray(teachers)) {
      const foundTeachers = await User.find({
        _id: { $in: teachers },
        role: 'teacher',
        school: schoolId,
      });

      if (foundTeachers.length !== teachers.length) {
        return res.status(400).json({ message: 'Some teacher IDs are invalid or not from your school' });
      }

      validTeachers = foundTeachers.map(t => t._id);
    }

    const newClass = new Class({
      name,
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
    res.status(500).json({ message: 'Error creating class', error: err.message });
  }
};

// ✅ Get all classes for a school (admin only, with populated teachers & students)
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
      .sort({ name: 1 });

    res.status(200).json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching classes', error: err.message });
  }
};

// ✅ Get classes assigned to a teacher (teacher only, no students)
exports.getTeacherClasses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    const schoolId = req.user.school;

    const teacher = await User.findOne({ _id: teacherId, role: 'teacher', school: schoolId });
    if (!teacher) return res.status(404).json({ message: 'Teacher not found' });

    const classes = await Class.find({ school: schoolId, teachers: teacher._id })
      .select('_id name')
      .sort({ name: 1 });

    res.status(200).json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching teacher classes', error: err.message });
  }
};

// ✅ Update class (admin only)
exports.updateClass = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, teachers } = req.body;
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(400).json({ message: 'School context missing from token' });
    }

    const classToUpdate = await Class.findOne({ _id: id, school: schoolId });
    if (!classToUpdate) {
      return res.status(404).json({ message: 'Class not found or unauthorized' });
    }

    if (name && name !== classToUpdate.name) {
      const existingClass = await Class.findOne({ name, school: schoolId, _id: { $ne: id } });
      if (existingClass) {
        return res.status(400).json({ message: 'Class with this name already exists in your school' });
      }
      classToUpdate.name = name;
    }

    if (teachers && Array.isArray(teachers)) {
      const foundTeachers = await User.find({ _id: { $in: teachers }, role: 'teacher', school: schoolId });
      if (foundTeachers.length !== teachers.length) {
        return res.status(400).json({ message: 'Some teacher IDs are invalid or not from your school' });
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
    res.status(500).json({ message: 'Error updating class', error: err.message });
  }
};

// ✅ Delete class (admin only)
exports.deleteClass = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;

    const found = await Class.findOne({ _id: id, school: schoolId });
    if (!found) return res.status(404).json({ message: 'Class not found or unauthorized' });

    await Class.findByIdAndDelete(id);
    res.json({ message: 'Class deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting class', error: err.message });
  }
};

// ✅ Assign or change class teacher (admin only)
exports.assignClassTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    const { teacherId } = req.body;
    const schoolId = req.user.school;

    // Find class
    const classDoc = await Class.findOne({ _id: classId, school: schoolId });
    if (!classDoc) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Find teacher
    const teacher = await User.findOne({
      _id: teacherId,
      role: 'teacher',
      school: schoolId
    });
    if (!teacher) {
      return res.status(400).json({ message: 'Teacher not found in your school' });
    }

    // 🔥 AUTO-REMOVE teacher from previous class (if any)
    const previousClass = await Class.findOne({
      school: schoolId,
      classTeacher: teacherId,
      _id: { $ne: classId }  // Ignore the class we're assigning to
    });

    if (previousClass) {
      previousClass.classTeacher = null;
      await previousClass.save();
    }

    // Assign to new class
    classDoc.classTeacher = teacherId;
    await classDoc.save();

    // Populate after save
    const updatedClass = await Class.findById(classDoc._id)
      .populate('teachers', 'name email')
      .populate('classTeacher', 'name email')
      .populate('students', 'name email');

    res.status(200).json({
      success: true,
      message: previousClass
        ? `Teacher moved from ${previousClass.name} to ${classDoc.name}`
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
