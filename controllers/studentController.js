const User = require('../models/User');
const Student = require('../models/Student');
const Class = require('../models/Class');
const Notification = require('../models/Notification');
const StudentAttendance = require('../models/StudentAttendance');
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
// ✅ Admin-only: Admit/enroll student (multi-school aware)
exports.createStudent = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      gender,
      dob,
      guardianName,
      guardianPhone,
      classId,
      academicYear
    } = req.body;

    console.log('📥 Creating student with data:', req.body);

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.warn('⚠️ Duplicate email attempt:', email);
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Helper to format gender to Title Case (Male/Female)
    const formatGender = (g) => {
      if (!g || typeof g !== 'string') return 'Male';
      const lower = g.toLowerCase().trim();
      if (lower === 'female' || lower === 'girl' || lower === 'f') return 'Female';
      return 'Male';
    };

    const formattedGender = formatGender(gender);

    const user = new User({
      name,
      email,
      password,
      gender: formattedGender, // ✅ Pass validated gender to User
      role: 'student',
      school: req.user.school
    });
    await user.save();
    console.log('✅ Created user:', user._id);

    // Generate sequential admission number
    const existingStudents = await Student.find({ school: req.user.school }).select('admissionNumber');
    const numericAdmNos = existingStudents
      .map(s => parseInt(s.admissionNumber, 10))
      .filter(n => !isNaN(n));

    let nextNum = 1;
    if (numericAdmNos.length > 0) {
      nextNum = Math.max(...numericAdmNos) + 1;
    }
    const admissionNumber = String(nextNum).padStart(3, '0');

    const studentData = {
      user: user._id,
      admissionNumber,
      gender: formattedGender,
      dateOfBirth: dob,
      guardianName,
      guardianPhone,
      academicYear,
      school: req.user.school
    };

    if (classId) {
      const selectedClass = await Class.findById(classId);
      if (!selectedClass) return res.status(404).json({ message: 'Class not found' });
      studentData.class = classId;
    }

    const student = new Student(studentData);
    await student.save();
    console.log('✅ Student saved:', student._id);

    try {
      const admins = await User.find({ role: 'admin', school: req.user.school }).select('_id');
      const adminIds = admins.map(admin => admin._id);

      await Promise.all([
        Notification.create({
          sender: req.user._id,
          recipientUsers: [user._id],
          message: `🎉 Welcome ${name}! Your student account has been created.`,
          school: req.user.school
        }),
        Notification.create({
          sender: req.user._id,
          recipientUsers: adminIds,
          message: `📢 New student "${name}" has been enrolled.`,
          school: req.user.school
        }),
      ]);

      console.log('✅ Notifications sent');
    } catch (notifyErr) {
      console.warn('⚠️ Notification failed:', notifyErr.message);
    }

    res.status(201).json({ message: 'Student created successfully', student });

  } catch (err) {
    console.error('❌ Error creating student:', err);
    res.status(500).json({ message: 'Error creating student', error: err.message });
  }
};

// ✅ View all students (optionally filtered by class, academicYear)
exports.getAllStudents = async (req, res) => {
  try {
    const filter = { school: req.user.school };

    if (req.query.classId) filter.class = req.query.classId;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const students = await Student.find(filter)
      .populate('user', 'name email')
      .populate('class', 'name')
      .sort({ 'user.name': 1 }); // Sort by user.name in ascending order

    res.json(students);
  } catch (err) {
    console.error('❌ Error fetching students:', err);
    res.status(500).json({ message: 'Error fetching students', error: err.message });
  }
};


// ✅ Update student and linked user info
exports.updateStudent = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    email,
    guardianName,
    guardianPhone,
    gender,
    dob,
    classId,
    academicYear
  } = req.body;

  try {
    const student = await Student.findOne({ _id: id, school: req.user.school });
    if (!student) return res.status(404).json({ message: 'Student not found' });

    student.gender = gender;
    student.dateOfBirth = dob;
    student.guardianName = guardianName;
    student.guardianPhone = guardianPhone;
    student.academicYear = academicYear;

    if (classId) {
      const selectedClass = await Class.findById(classId);
      if (!selectedClass) return res.status(404).json({ message: 'Class not found' });
      student.class = classId;
    }

    await student.save();

    const user = await User.findOne({ _id: student.user, school: req.user.school });
    if (user) {
      user.name = name;
      user.email = email;
      await user.save();
    }

    res.json({ message: 'Student updated successfully', student });
  } catch (err) {
    console.error('❌ Error updating student:', err);
    res.status(500).json({ message: 'Error updating student', error: err.message });
  }
};

// ✅ Delete student and linked user
exports.deleteStudent = async (req, res) => {
  const { id } = req.params;

  let session;
  try {
    session = await mongoose.startSession();
    session.startTransaction();

    // delete the student (scoped to school)
    const student = await Student.findOneAndDelete({ _id: id, school: req.user.school }).session(session);
    if (!student) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Student not found' });
    }

    // delete linked user
    const deletedUser = await User.findOneAndDelete({ _id: student.user, school: req.user.school }).session(session);

    // delete dependent feeding fee and attendance records (using the exact models your app uses)
    const feeDeleteRes = await FeedingFeeRecord.deleteMany({ student: student._id }).session(session);
    const attendanceDeleteRes = await StudentAttendance.deleteMany({ student: student._id }).session(session);

    await session.commitTransaction();
    session.endSession();

    console.info(`Deleted student ${student._id}. FeedingFeeRecords deleted: ${feeDeleteRes.deletedCount}. StudentAttendance deleted: ${attendanceDeleteRes.deletedCount}`);

    return res.json({
      message: 'Student deleted',
      studentId: student._id,
      userDeleted: !!deletedUser,
      deletedFeedingFees: feeDeleteRes.deletedCount,
      deletedAttendances: attendanceDeleteRes.deletedCount
    });
  } catch (err) {
    // Transaction failed or not supported: fallback best-effort
    console.error('Error deleting student (transaction attempt failed):', err);
    try {
      if (session) {
        try { await session.abortTransaction(); } catch (e) { /* ignore */ }
        session.endSession();
      }
    } catch (e) { /* ignore session cleanup errors */ }

    // Best-effort fallback (non-transactional)
    try {
      const student = await Student.findOneAndDelete({ _id: id, school: req.user.school });
      if (!student) return res.status(404).json({ message: 'Student not found (fallback attempt)' });

      const deletedUser = await User.findOneAndDelete({ _id: student.user, school: req.user.school });
      const feeDeleteRes = await FeedingFeeRecord.deleteMany({ student: student._id });
      const attendanceDeleteRes = await StudentAttendance.deleteMany({ student: student._id });

      console.info(`Fallback: Deleted student ${student._id}. FeedingFeeRecords deleted: ${feeDeleteRes.deletedCount}. StudentAttendance deleted: ${attendanceDeleteRes.deletedCount}`);

      return res.json({
        message: 'Student deleted (fallback)',
        studentId: student._id,
        userDeleted: !!deletedUser,
        deletedFeedingFees: feeDeleteRes.deletedCount,
        deletedAttendances: attendanceDeleteRes.deletedCount,
        note: 'Transaction failed; performed best-effort deletions.'
      });
    } catch (fallbackErr) {
      console.error('Fallback deletion also failed:', fallbackErr);
      return res.status(500).json({ message: 'Error deleting student', error: fallbackErr.message || err.message });
    }
  }
};

// ✅ Assign student to class
exports.assignStudentToClass = async (req, res) => {
  const { id } = req.params;
  const { classId } = req.body;

  try {
    const student = await Student.findOne({ _id: id, school: req.user.school });
    if (!student) return res.status(404).json({ message: 'Student not found' });

    const selectedClass = await Class.findById(classId);
    if (!selectedClass) return res.status(404).json({ message: 'Class not found' });

    student.class = classId;
    await student.save();

    res.json({ message: 'Student assigned to class successfully', student });
  } catch (err) {
    console.error('❌ Error assigning class:', err);
    res.status(500).json({ message: 'Error assigning student to class', error: err.message });
  }
};
// ✅ Get students by classId
exports.getStudentsByClassId = async (req, res) => {
  try {
    const { classId } = req.params;

    const students = await Student.find({
      class: classId,
      school: req.user.school
    })
      .populate('user', 'name email')
      .populate('class', 'name')
      .sort({ 'user.name': 1 }); // Sort by user.name in ascending order

    res.status(200).json(students);
  } catch (err) {
    console.error('❌ Error fetching students by class:', err);
    res.status(500).json({ message: 'Failed to fetch students by class', error: err.message });
  }
};
exports.getStudentByUserId = async (req, res) => {
  const { userId } = req.params;
  try {
    const student = await Student.findOne({ user: userId }).populate("class");
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json(student);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
exports.getStudentById = async (req, res) => {
  try {
    const { id } = req.params;

    // Populate related user, class, and school data
    const student = await Student.findById(id)
      .populate("user", "name email")
      .populate("class", "name")
      .populate("school", "name");

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Format the response to include child name and related data
    const formatted = {
      _id: student._id,
      name: student.user?.name || "Unnamed Student",
      email: student.user?.email || "",
      class: student.class?.name || "Unassigned",
      school: student.school?.name || "",
      academicYear: student.academicYear,
      gender: student.gender,
      guardianName: student.guardianName,
      guardianPhone: student.guardianPhone,
    };

    res.json(formatted);
  } catch (error) {
    console.error("❌ Error fetching student by ID:", error);
    res.status(500).json({
      message: "Failed to fetch student details",
      error: error.message,
    });
  }
};

