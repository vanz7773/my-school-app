const User = require('../models/User');
const Student = require('../models/Student');
const Class = require('../models/Class');
const Notification = require('../models/Notification');
const StudentAttendance = require('../models/StudentAttendance');
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const enrollmentController = require('./enrollmentController'); // Ensure cache clearing support
// ✅ Admin-only: Admit/enroll student (multi-school aware)
exports.createStudent = async (req, res) => {
  let createdUserId = null;
  try {
    const {
      name,
      email,
      password,
      gender,
      dob,
      guardianPhone,
      guardianPhone2,
      guardianOccupation,
      classId,
      academicYear,
      religion,
      hometown,
      languageSpoken,
      fatherName,
      fatherOccupation,
      motherName,
      motherOccupation,
      admissionNumber: manualAdmissionNumber
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
    createdUserId = user._id;
    console.log('✅ Created user:', user._id);

    let admissionNumber;

    if (manualAdmissionNumber) {
      // Check for uniqueness
      const existing = await Student.findOne({ school: req.user.school, admissionNumber: String(manualAdmissionNumber).trim() });
      if (existing) {
        return res.status(400).json({ message: `Admission number ${manualAdmissionNumber} is already in use.` });
      }
      admissionNumber = String(manualAdmissionNumber).trim();
    } else {
      // Generate sequential admission number
      const existingStudents = await Student.find({ school: req.user.school }).select('admissionNumber');
      const numericAdmNos = existingStudents
        .map(s => parseInt(s.admissionNumber, 10))
        .filter(n => !isNaN(n));

      let nextNum = 1;
      if (numericAdmNos.length > 0) {
        nextNum = Math.max(...numericAdmNos) + 1;
      }
      admissionNumber = String(nextNum).padStart(3, '0');
    }

    const studentData = {
      user: user._id,
      admissionNumber,
      gender: formattedGender,
      dateOfBirth: dob,
      guardianPhone,
      guardianPhone2,
      guardianOccupation,
      academicYear,
      religion,
      hometown,
      languageSpoken,
      fatherName,
      fatherOccupation,
      motherName,
      motherOccupation,
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

    try {
      if (enrollmentController.clearEnrollmentCache) {
        enrollmentController.clearEnrollmentCache(req.user.school);
      }
    } catch (cacheErr) {
      console.warn('⚠️ Failed to clear enrollment cache:', cacheErr.message);
    }

    res.status(201).json({ message: 'Student created successfully', student });

  } catch (err) {
    if (createdUserId) {
      await User.findByIdAndDelete(createdUserId).catch(e => console.error("Rollback failed for single student:", e));
    }
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
    guardianPhone,
    guardianPhone2,
    guardianOccupation,
    gender,
    dob,
    classId,
    academicYear,
    religion,
    hometown,
    languageSpoken,
    fatherName,
    fatherOccupation,
    motherName,
    motherOccupation,
    // Admission Register Fields
    surname,
    otherNames,
    dateOfAdmission,
    lastSchoolAttended,
    dateOfLeaving,
    causeForLeaving,
    remarks
  } = req.body;

  try {
    const student = await Student.findOne({ _id: id, school: req.user.school });
    if (!student) return res.status(404).json({ message: 'Student not found' });

    if (gender !== undefined) student.gender = gender;
    if (dob !== undefined) student.dateOfBirth = dob;
    if (guardianPhone !== undefined) student.guardianPhone = guardianPhone;
    if (guardianPhone2 !== undefined) student.guardianPhone2 = guardianPhone2;
    if (guardianOccupation !== undefined) student.guardianOccupation = guardianOccupation;
    if (academicYear !== undefined) student.academicYear = academicYear;
    if (religion !== undefined) student.religion = religion;
    if (hometown !== undefined) student.hometown = hometown;
    if (languageSpoken !== undefined) student.languageSpoken = languageSpoken;
    if (fatherName !== undefined) student.fatherName = fatherName;
    if (fatherOccupation !== undefined) student.fatherOccupation = fatherOccupation;
    if (motherName !== undefined) student.motherName = motherName;
    if (motherOccupation !== undefined) student.motherOccupation = motherOccupation;

    // Admission Register Fields
    if (surname !== undefined) student.surname = surname;
    if (otherNames !== undefined) student.otherNames = otherNames;
    if (dateOfAdmission !== undefined) student.dateOfAdmission = dateOfAdmission;
    if (lastSchoolAttended !== undefined) student.lastSchoolAttended = lastSchoolAttended;
    if (dateOfLeaving !== undefined) student.dateOfLeaving = dateOfLeaving;
    if (causeForLeaving !== undefined) student.causeForLeaving = causeForLeaving;
    if (remarks !== undefined) student.remarks = remarks;

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
      guardianPhone: student.guardianPhone,
      guardianOccupation: student.guardianOccupation,
      religion: student.religion,
      hometown: student.hometown,
      languageSpoken: student.languageSpoken,
      fatherName: student.fatherName,
      fatherOccupation: student.fatherOccupation,
      motherName: student.motherName,
      motherOccupation: student.motherOccupation,
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

// ✅ BULK Admit/enroll students
exports.bulkCreateStudents = async (req, res) => {
  try {
    const { students: studentList } = req.body;
    if (!Array.isArray(studentList) || studentList.length === 0) {
      return res.status(400).json({ message: 'No students provided for bulk enrollment' });
    }

    console.log(`📥 Bulk creating ${studentList.length} students`);

    const results = {
      success: [],
      errors: []
    };

    // Helper to format gender
    const formatGender = (g) => {
      if (!g || typeof g !== 'string') return 'Male';
      const lower = g.toLowerCase().trim();
      if (lower === 'female' || lower === 'girl' || lower === 'f') return 'Female';
      return 'Male';
    };

    // 1. Get starting admission number
    const existingStudents = await Student.find({ school: req.user.school }).select('admissionNumber');
    const numericAdmNos = existingStudents
      .map(s => parseInt(s.admissionNumber, 10))
      .filter(n => !isNaN(n));
    
    let nextNum = numericAdmNos.length > 0 ? Math.max(...numericAdmNos) + 1 : 1;

    // 1.5. Prepare Class mapping (Name -> ID) for easier lookup
    const allClasses = await Class.find({ school: req.user.school }).select('name _id displayName stream');
    const classMap = {};
    allClasses.forEach(c => {
      // Map both name (e.g. "BASIC 1") and displayName (e.g. "BASIC 1A")
      if (c.name) classMap[c.name.toLowerCase().trim()] = c._id;
      if (c.displayName) classMap[c.displayName.toLowerCase().trim()] = c._id;
      
      // Also handle "Name Stream" combinations if relevant
      if (c.name && c.stream) {
        const full = `${c.name} ${c.stream}`.toLowerCase().trim();
        classMap[full] = c._id;
      }
    });

    // 2. Process each student
    for (const data of studentList) {
      const { 
        name, email, password, gender, dob, classId, className, academicYear, 
        guardianPhone, guardianPhone2, guardianOccupation, religion, hometown, 
        languageSpoken, fatherName, fatherOccupation, motherName, motherOccupation 
      } = data;

      let createdUserId = null;

      try {
        
        // Parse DD/MM/YYYY or DD-MM-YYYY dates
        let parsedDob = dob;
        if (parsedDob && typeof parsedDob === 'string') {
          const parts = parsedDob.split(/[-\/]/); 
          if (parts.length === 3 && parts[2].length === 4) {
               // Assuming DD/MM/YYYY
               parsedDob = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          }
        }
        // Validation basic
        if (!name || !email) {
          throw new Error(`Missing required fields for student: ${name || 'Unknown'}`);
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
          throw new Error(`Email already exists: ${email}`);
        }

        // Admission Number Handling
        let studentAdmissionNumber;
        if (data.admissionNumber) {
          const trimmedNo = String(data.admissionNumber).trim();
          const existingNo = await Student.findOne({ school: req.user.school, admissionNumber: trimmedNo });
          if (existingNo) {
            throw new Error(`Admission number ${trimmedNo} is already in use.`);
          }
          studentAdmissionNumber = trimmedNo;

          // If manual number is numeric, update starting point for next auto-generated one
          const numericVal = parseInt(trimmedNo, 10);
          if (!isNaN(numericVal) && numericVal >= nextNum) {
            nextNum = numericVal + 1;
          }
        } else {
          studentAdmissionNumber = String(nextNum).padStart(3, '0');
          nextNum++;
        }

        const formattedGender = formatGender(gender);

        // Create User
        const user = new User({
          name,
          email,
          password: password || 'Student123!', // Default password if none provided
          gender: formattedGender,
          role: 'student',
          school: req.user.school
        });
        await user.save();
        createdUserId = user._id;

        // Assign Admission Number
        const admissionNumber = String(nextNum).padStart(3, '0');
        nextNum++;

        // Phone number formatting (Excel strips leading zeros from 10-digit numbers making them 9 digits)
        let formattedPhone = guardianPhone;
        if (formattedPhone && String(formattedPhone).trim().length === 9) {
            formattedPhone = '0' + String(formattedPhone).trim();
        }
        let formattedPhone2 = guardianPhone2;
        if (formattedPhone2 && String(formattedPhone2).trim().length === 9) {
            formattedPhone2 = '0' + String(formattedPhone2).trim();
        }

        // Create Student
        const studentData = {
          user: user._id,
          admissionNumber: studentAdmissionNumber,
          gender: formattedGender,
          dateOfBirth: parsedDob,
          guardianPhone: formattedPhone,
          guardianPhone2: formattedPhone2,
          guardianOccupation,
          academicYear,
          religion,
          hometown,
          languageSpoken,
          fatherName,
          fatherOccupation,
          motherName,
          motherOccupation,
          school: req.user.school
        };

        if (classId) {
          studentData.class = classId;
        } else if (className) {
          const lookupName = String(className).toLowerCase().trim();
          if (classMap[lookupName]) {
            studentData.class = classMap[lookupName];
          } else {
            console.warn(`⚠️ Bulk Creation: Class name "${className}" not found for student ${name}`);
            // We still proceed, but the student won't have a class assigned
          }
        }

        const student = new Student(studentData);
        await student.save();

        results.success.push({ name, email, admissionNumber });

        // Optional: Single notifications for student (async non-blocking)
        Notification.create({
          sender: req.user._id,
          recipientUsers: [user._id],
          message: `🎉 Welcome ${name}! Your student account has been created.`,
          school: req.user.school
        }).catch(err => console.warn('Individual student notification failed', err.message));

      } catch (err) {
        if (createdUserId) {
          await User.findByIdAndDelete(createdUserId).catch(e => console.error("Rollback failed:", e));
        }
        results.errors.push({ name: data.name || 'Unknown', email: data.email || 'N/A', message: err.message });
      }
    }

    // 3. Batch notification for Admin
    if (results.success.length > 0) {
      try {
        const admins = await User.find({ role: 'admin', school: req.user.school }).select('_id');
        const adminIds = admins.map(admin => admin._id);
        
        await Notification.create({
          sender: req.user._id,
          recipientUsers: adminIds,
          message: `📢 Bulk Enrollment Complete: ${results.success.length} students added.`,
          school: req.user.school
        });

        if (enrollmentController.clearEnrollmentCache) {
          enrollmentController.clearEnrollmentCache(req.user.school);
        }
      } catch (postProcessErr) {
        console.warn('Post-bulk creation processing failed:', postProcessErr.message);
      }
    }

    res.status(201).json({
      message: `Processed ${studentList.length} students`,
      summary: {
        total: studentList.length,
        successCount: results.success.length,
        errorCount: results.errors.length
      },
      results
    });

  } catch (err) {
    console.error('❌ Error in bulkCreateStudents:', err);
    res.status(500).json({ message: 'Error in bulk student creation', error: err.message });
  }
};

