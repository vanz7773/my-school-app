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
      .populate('class', 'name')
      .populate('teacher', 'name email'); // teacher is a User id
    res.json({ success: true, results });
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
    const teacher = await Teacher.findOne({ user: req.user._id, school: req.user.school });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher profile not found' });

    // find classes where teacher is either classTeacher (User id) or listed in teachers array
    const classes = await Class.find({
      school: req.user.school,
      $or: [
        { classTeacher: teacher.user }, // classTeacher stores User _id
        { teachers: teacher.user }      // teachers array stores User _id
      ]
    }).select('_id');

    const classIds = classes.map(c => c._id);

    const results = await Timetable.find({
      school: req.user.school,
      $or: [
        { teacher: teacher.user },         // direct teacher entries (User _id)
        { class: { $in: classIds } }       // all entries for classes they teach/lead
      ],
    })
      .populate('class', 'name')
      .populate('teacher', 'name email'); // teacher references User

    res.json({ success: true, timetable: results });
  } catch (err) {
    console.error('Error fetching teacher timetable:', err);
    res.status(500).json({ success: false, message: 'Error fetching teacher timetable', error: err.message });
  }
};

// ----------------------
// Student: View own class timetable (Scoped by school)
exports.getStudentTimetable = async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ success: false, message: 'Access denied' });

    const student = await Student.findOne({ user: req.user._id, school: req.user.school }).populate('class', '_id');
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const results = await Timetable.find({ class: student.class._id, school: req.user.school })
      .populate('teacher', 'name email')
      .populate('class', 'name');

    res.json({ success: true, timetable: results });
  } catch (err) {
    console.error('Error fetching student timetable:', err);
    res.status(500).json({ success: false, message: 'Error fetching timetable', error: err.message });
  }
};

// ----------------------
// Parent: View all children’s timetables (Scoped by school)
// NOTE: fix - ensure we populate the student's user to get a display name
exports.getParentTimetables = async (req, res) => {
  try {
    if (req.user.role !== 'parent') return res.status(403).json({ success: false, message: 'Access denied' });

    const children = await Student.find({ parent: req.user._id, school: req.user.school })
      .populate('class', 'name')
      .populate('user', 'name'); // important: get student's display name

    if (!children.length) return res.status(404).json({ success: false, message: 'No linked children found' });

    const timetables = {};
    for (const child of children) {
      const childTimetable = await Timetable.find({
        class: child.class._id,
        school: req.user.school
      })
        .populate('teacher', 'name email')
        .populate('class', 'name');

      // prefer student user.name if present, else fallback to student._id
      const childName = (child.user && child.user.name) ? child.user.name : String(child._id);
      timetables[childName] = childTimetable;
    }

    res.json({ success: true, message: 'Parent timetables fetched successfully', timetables });
  } catch (err) {
    console.error('Error fetching parent timetables:', err);
    res.status(500).json({ success: false, message: 'Error fetching parent timetables', error: err.message });
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
      .populate('class', 'name')
      .populate('teacher', 'name email');

    res.status(201).json({ success: true, message: 'Timetable entry created', timetable: populated });
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
      .populate('class', 'name')
      .populate('teacher', 'name email');

    res.status(201).json({ success: true, message: 'Timetable entry created successfully', timetable: populated });
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
      .populate('class', 'name')
      .populate('teacher', 'name email');

    res.json({ success: true, message: 'Timetable entry updated', timetable: populated });
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
// NEW: Get the classTeacher for a class (useful for timetable UI)
// Returns the user object for classTeacher and the related Teacher doc (if exists)
exports.getClassTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    if (!classId) return res.status(400).json({ success: false, message: 'classId is required' });

    const cls = await Class.findOne({ _id: classId, school: req.user.school })
      .populate('classTeacher', 'name email') // user doc
      .populate('teachers', 'name email');    // team of subject teachers

    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

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
      className: cls.name,
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
// NEW: Get classes assigned to a teacher (for timetable UX) - returns both where they are classTeacher and where they are subject teacher
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
    }).select('_id name classTeacher teachers').populate('classTeacher', 'name email');

    res.json({ success: true, total: classes.length, classes });
  } catch (err) {
    console.error('Error fetching teacher assigned classes:', err);
    res.status(500).json({ success: false, message: 'Error fetching classes', error: err.message });
  }
};
