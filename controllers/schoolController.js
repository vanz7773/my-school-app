// ✅ schoolController.js — Updated for Polygon-based geofence

const User = require('../models/User');
const Student = require('../models/Student');
const Class = require('../models/Class');
const School = require('../models/School');
const Notification = require('../models/Notification');

// ✅ Admin-only: Set geofence using Polygon coordinates
exports.setGeofence = async (req, res) => {
  try {
    const { coordinates } = req.body; // Expecting array of [lng, lat]

    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 3 ||
      !coordinates.every(pair => Array.isArray(pair) && pair.length === 2)
    ) {
      return res.status(400).json({ message: 'Invalid Polygon coordinates' });
    }

    // Ensure polygon is closed
    const closedCoordinates =
      JSON.stringify(coordinates[0]) === JSON.stringify(coordinates[coordinates.length - 1])
        ? coordinates
        : [...coordinates, coordinates[0]];

    const school = await School.findById(req.user.school);
    if (!school) return res.status(404).json({ message: 'School not found' });

    // ✅ Save to the schema’s "location" field
    school.location = {
      type: 'Polygon',
      coordinates: [closedCoordinates],
    };

    await school.save();

    res.json({
      message: '✅ Geofence polygon saved successfully',
      location: school.location,
    });
  } catch (err) {
    console.error('❌ Error setting geofence polygon:', err);
    res.status(500).json({ message: 'Error saving geofence', error: err.message });
  }
};


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
      academicYear,
    } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const user = new User({
      name,
      email,
      password,
      role: 'student',
      school: req.user.school,
    });
    await user.save();

    const admissionNumber = `STU-${Date.now()}`;

    const studentData = {
      user: user._id,
      admissionNumber,
      gender,
      dateOfBirth: dob,
      guardianName,
      guardianPhone,
      academicYear,
      school: req.user.school,
    };

    if (classId) {
      const selectedClass = await Class.findById(classId);
      if (!selectedClass) return res.status(404).json({ message: 'Class not found' });
      studentData.class = classId;
    }

    const student = new Student(studentData);
    await student.save();

    try {
      const admins = await User.find({ role: 'admin', school: req.user.school }).select('_id');
      const adminIds = admins.map((admin) => admin._id);

      await Promise.all([
        Notification.create({
          sender: req.user._id,
          recipientUsers: [user._id],
          message: `🎉 Welcome ${name}! Your student account has been created.`,
          school: req.user.school,
        }),
        Notification.create({
          sender: req.user._id,
          recipientUsers: adminIds,
          message: `📢 New student "${name}" has been enrolled.`,
          school: req.user.school,
        }),
      ]);
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
      .populate('class', 'name');

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
    academicYear,
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
  try {
    const student = await Student.findOneAndDelete({ _id: id, school: req.user.school });
    if (!student) return res.status(404).json({ message: 'Student not found' });

    await User.findOneAndDelete({ _id: student.user, school: req.user.school });

    res.json({ message: 'Student deleted' });
  } catch (err) {
    console.error('❌ Error deleting student:', err);
    res.status(500).json({ message: 'Error deleting student', error: err.message });
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
