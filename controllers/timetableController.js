// controllers/timetableController.js
const Timetable = require('../models/Timetable');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Class = require('../models/Class');
const User = require('../models/User');

// Helper: resolve teacher user id from either a teacher user-id or a teacher-doc id
async function resolveTeacherUserId(candidateId, schoolId) {
  if (!candidateId) return null;

  // If candidateId corresponds to a User in this school with role 'teacher' -> return it
  const userAsTeacher = await User.findOne({ _id: candidateId, role: 'teacher', school: schoolId }).select('_id');
  if (userAsTeacher) return userAsTeacher._id;

  // Otherwise, maybe candidateId is a Teacher document id => fetch Teacher doc and return its user
  const teacherDoc = await Teacher.findOne({ _id: candidateId, school: schoolId }).select('user');
  if (teacherDoc) return teacherDoc.user;

  return null;
}

// ==============================
// Helper: Normalize class names safely
// ==============================
function normalizeClass(cls) {
  if (!cls) return null;

  const name = cls.name || "Unassigned";
  const classDisplayName =
    cls.displayName ||
    cls.classDisplayName ||
    (cls.stream ? `${name}${cls.stream}` : name);

  return {
    ...cls.toObject?.() ?? cls,
    name,
    classDisplayName
  };
}

// ----------------------
// Admin: Filter timetable by class/teacher/day (Scoped by school)
exports.getFilteredTimetable = async (req, res) => {
  const { classId, teacherId, day } = req.query;
  const filter = { school: req.user.school };

  if (classId) filter.class = classId;
  if (day) filter.day = day;

  try {
    if (teacherId) {
      const resolvedTeacherUserId = await resolveTeacherUserId(teacherId, req.user.school);
      if (!resolvedTeacherUserId) {
        return res.status(400).json({ success: false, message: 'Invalid teacherId' });
      }
      filter.teacher = resolvedTeacherUserId;
    }

    const results = await Timetable.find(filter)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email'); // teacher is a User id
    
    // ✅ USE normalizeClass
    const timetable = results.map(entry => ({
      ...entry.toObject(),
      class: normalizeClass(entry.class)
    }));
    
    res.json({ success: true, results: timetable });
  } catch (err) {
    console.error('Error fetching filtered timetable:', err);
    res.status(500).json({ success: false, message: 'Error fetching timetable', error: err.message });
  }
};

// ----------------------
// Teacher: View own timetable (Scoped by school)
exports.getTeacherTimetable = async (req, res) => {
  try {
    // find Teacher profile
    const teacher = await Teacher.findOne({
      user: req.user._id,
      school: req.user.school
    });
    if (!teacher)
      return res.status(404).json({ success: false, message: 'Teacher profile not found' });

    // find classes where teacher is either classTeacher or subject teacher
    const classes = await Class.find({
      school: req.user.school,
      $or: [
        { classTeacher: teacher.user },
        { teachers: teacher.user }
      ]
    }).select('_id');

    const classIds = classes.map(c => c._id);

    const results = await Timetable.find({
      school: req.user.school,
      $or: [
        { teacher: teacher.user },
        { class: { $in: classIds } }
      ],
    })
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');

    // ✅ USE normalizeClass
    const timetable = results.map(entry => ({
      ...entry.toObject(),
      class: normalizeClass(entry.class)
    }));

    res.json({ success: true, timetable });

  } catch (err) {
    console.error('Error fetching teacher timetable:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching teacher timetable',
      error: err.message
    });
  }
};

// ----------------------
// Student: View own class timetable (Scoped by school)
exports.getStudentTimetable = async (req, res) => {
  try {
    if (req.user.role !== 'student')
      return res.status(403).json({ success: false, message: 'Access denied' });

    const student = await Student.findOne({
      user: req.user._id,
      school: req.user.school
    }).populate('class', '_id');

    if (!student)
      return res.status(404).json({ success: false, message: 'Student not found' });

    const results = await Timetable.find({
      class: student.class._id,
      school: req.user.school
    })
      .populate('teacher', 'name email')
      .populate('class', 'name stream displayName');

    // ✅ USE normalizeClass
    const timetable = results.map(entry => ({
      ...entry.toObject(),
      class: normalizeClass(entry.class)
    }));

    res.json({ success: true, timetable });

  } catch (err) {
    console.error('Error fetching student timetable:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching timetable',
      error: err.message
    });
  }
};

// ----------------------
// Parent: View all children's timetables (Scoped by school)
exports.getParentTimetables = async (req, res) => {
  try {
    if (req.user.role !== 'parent')
      return res.status(403).json({ success: false, message: 'Access denied' });

    const children = await Student.find({
      parent: req.user._id,
      school: req.user.school
    })
      .populate('class', 'name stream displayName')
      .populate('user', 'name');

    if (!children.length)
      return res.status(404).json({ success: false, message: 'No linked children found' });

    const timetables = {};

    for (const child of children) {
      const results = await Timetable.find({
        class: child.class._id,
        school: req.user.school
      })
        .populate('teacher', 'name email')
        .populate('class', 'name stream displayName');

      // ✅ USE normalizeClass
      const normalizedTimetable = results.map(entry => ({
        ...entry.toObject(),
        class: normalizeClass(entry.class)
      }));

      // Prefer student user.name if present
      const childName = child.user?.name || String(child._id);
      timetables[childName] = normalizedTimetable;
    }

    res.json({
      success: true,
      message: 'Parent timetables fetched successfully',
      timetables
    });

  } catch (err) {
    console.error('Error fetching parent timetables:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching parent timetables',
      error: err.message
    });
  }
};

// ----------------------
// Admin: Create new timetable entry
exports.createTimetableEntry = async (req, res) => {
  try {
    const { classId, teacherId, subject, day, startTime, endTime } = req.body;

    // Validate class
    const cls = await Class.findOne({ _id: classId, school: req.user.school });
    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

    // Resolve teacher user id (accepts either a User id or a Teacher doc id)
    const resolvedTeacherUserId = await resolveTeacherUserId(teacherId, req.user.school);
    if (!resolvedTeacherUserId) return res.status(404).json({ success: false, message: 'Teacher not found' });

    const newEntry = new Timetable({
      class: classId,
      teacher: resolvedTeacherUserId,
      subject,
      day,
      startTime,
      endTime,
      school: req.user.school
    });

    await newEntry.save();

    const populated = await Timetable.findById(newEntry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');

    // ✅ USE normalizeClass
    const normalizedTimetable = {
      ...populated.toObject(),
      class: normalizeClass(populated.class)
    };

    res.status(201).json({ success: true, message: 'Timetable entry created', timetable: normalizedTimetable });
  } catch (err) {
    console.error('Error creating timetable entry:', err);
    res.status(500).json({ success: false, message: 'Error creating entry', error: err.message });
  }
};

// ----------------------
// Class Teacher: Create timetable for their own class
exports.createClassTeacherTimetable = async (req, res) => {
  try {
    const { classId, subject, day, startTime, endTime } = req.body;

    const teacher = await Teacher.findOne({ user: req.user._id, school: req.user.school });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher profile not found' });

    // Only classTeacher can create entries
    const cls = await Class.findOne({
      _id: classId,
      school: req.user.school,
      classTeacher: teacher.user
    });

    if (!cls) return res.status(403).json({ success: false, message: 'Only class teacher can create timetable for this class' });

    const newEntry = new Timetable({
      class: classId,
      teacher: teacher.user,
      subject,
      day,
      startTime,
      endTime,
      school: req.user.school
    });

    await newEntry.save();

    const populated = await Timetable.findById(newEntry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');

    // ✅ USE normalizeClass
    const normalizedTimetable = {
      ...populated.toObject(),
      class: normalizeClass(populated.class)
    };

    res.status(201).json({ success: true, message: 'Timetable entry created successfully', timetable: normalizedTimetable });
  } catch (err) {
    console.error('Error creating class teacher entry:', err);
    res.status(500).json({ success: false, message: 'Error creating class teacher entry', error: err.message });
  }
};

// ----------------------
// Class Teacher: Update timetable entry
exports.updateTimetableEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, day, startTime, endTime } = req.body;

    const entry = await Timetable.findOne({ _id: id, school: req.user.school });
    if (!entry) return res.status(404).json({ success: false, message: 'Timetable entry not found' });

    if (req.user.role === 'teacher') {
      const teacher = await Teacher.findOne({ user: req.user._id, school: req.user.school });
      if (!teacher) return res.status(404).json({ success: false, message: 'Teacher profile not found' });

      // Only class teacher can update
      const cls = await Class.findOne({
        _id: entry.class,
        school: req.user.school,
        classTeacher: teacher.user
      });

      if (!cls) return res.status(403).json({ success: false, message: 'Only class teacher can update this timetable entry' });
    }

    if (subject) entry.subject = subject;
    if (day) entry.day = day;
    if (startTime) entry.startTime = startTime;
    if (endTime) entry.endTime = endTime;

    await entry.save();

    const populated = await Timetable.findById(entry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');

    // ✅ USE normalizeClass
    const normalizedTimetable = {
      ...populated.toObject(),
      class: normalizeClass(populated.class)
    };

    res.json({ success: true, message: 'Timetable entry updated', timetable: normalizedTimetable });
  } catch (err) {
    console.error('Error updating timetable entry:', err);
    res.status(500).json({ success: false, message: 'Error updating timetable entry', error: err.message });
  }
};

// ----------------------
// Class Teacher: Delete timetable entry
exports.deleteTimetableEntry = async (req, res) => {
  try {
    const { id } = req.params;

    const entry = await Timetable.findOne({ _id: id, school: req.user.school });
    if (!entry) return res.status(404).json({ success: false, message: 'Timetable entry not found' });

    if (req.user.role === 'teacher') {
      const teacher = await Teacher.findOne({ user: req.user._id, school: req.user.school });
      if (!teacher) return res.status(404).json({ success: false, message: 'Teacher profile not found' });

      // Only class teacher can delete
      const cls = await Class.findOne({
        _id: entry.class,
        school: req.user.school,
        classTeacher: teacher.user
      });

      if (!cls) return res.status(403).json({ success: false, message: 'Only class teacher can delete this timetable entry' });
    }

    await entry.deleteOne();
    res.json({ success: true, message: 'Timetable entry deleted successfully' });
  } catch (err) {
    console.error('Error deleting timetable entry:', err);
    res.status(500).json({ success: false, message: 'Error deleting timetable entry', error: err.message });
  }
};

// ----------------------
// Get the classTeacher for a class
exports.getClassTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    if (!classId) return res.status(400).json({ success: false, message: 'classId is required' });

    const cls = await Class.findOne({ _id: classId, school: req.user.school })
      .populate('classTeacher', 'name email')
      .populate('teachers', 'name email');

    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

    // ✅ USE normalizeClass for the class data
    const normalizedClass = normalizeClass(cls);

    // try to also fetch Teacher profile (if exists) that corresponds to classTeacher user
    let teacherProfile = null;
    if (cls.classTeacher) {
      teacherProfile = await Teacher.findOne({ user: cls.classTeacher._id, school: req.user.school })
        .select('-__v')
        .populate('user', 'name email');
    }

    res.json({
      success: true,
      classId: cls._id,
      className: normalizedClass.name,
      classDisplayName: normalizedClass.classDisplayName,
      classTeacher: cls.classTeacher || null,
      teacherProfile: teacherProfile || null,
      subjectTeachers: cls.teachers || []
    });
  } catch (err) {
    console.error('Error fetching class teacher:', err);
    res.status(500).json({ success: false, message: 'Error fetching class teacher', error: err.message });
  }
};

// ----------------------
// Get classes assigned to a teacher
exports.getTeacherAssignedClasses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

    // resolve teacher user id (accepts either Teacher doc id or User id)
    const resolvedTeacherUserId = await resolveTeacherUserId(teacherId, req.user.school);
    if (!resolvedTeacherUserId) return res.status(404).json({ success: false, message: 'Teacher not found' });

    const classes = await Class.find({
      school: req.user.school,
      $or: [
        { classTeacher: resolvedTeacherUserId },
        { teachers: resolvedTeacherUserId }
      ]
    }).select('_id name classTeacher teachers stream displayName').populate('classTeacher', 'name email');

    // ✅ USE normalizeClass for each class
    const normalizedClasses = classes.map(cls => normalizeClass(cls));

    res.json({ success: true, total: normalizedClasses.length, classes: normalizedClasses });
  } catch (err) {
    console.error('Error fetching teacher assigned classes:', err);
    res.status(500).json({ success: false, message: 'Error fetching classes', error: err.message });
  }
};

// ----------------------
// Teacher: View timetable for a specific class
exports.getTeacherClassTimetable = async (req, res) => {
  try {
    const { classId } = req.query;

    if (!classId)
      return res.status(400).json({ success: false, message: "classId is required" });

    const results = await Timetable.find({
      school: req.user.school,
      class: classId
    })
      .populate("class", "name stream displayName")
      .populate("teacher", "name email");

    // ✅ USE normalizeClass
    const timetable = results.map(entry => ({
      ...entry.toObject(),
      class: normalizeClass(entry.class)
    }));

    res.json({ success: true, timetable });

  } catch (err) {
    console.error('Error fetching class timetable:', err);
    res.status(500).json({
      success: false,
      message: "Error fetching timetable",
      error: err.message
    });
  }
};