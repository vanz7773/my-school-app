const User = require('../models/User');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const Class = require('../models/Class');
const Subject = require('../models/Subject');


// ====================================================================================
//  CREATE TEACHER  (multi-class + multi-subject support)
// ====================================================================================
exports.createTeacher = async (req, res) => {
  try {
    const { name, email, password, assignedClasses, subjects, phone, bio } = req.body;
    const currentSchool = req.user.school;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    // Check uniqueness on same school
    const existingUser = await User.findOne({ email, school: currentSchool });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email already exists in this school",
      });
    }

    // ---------------------------------------------
    // Validate assigned classes
    // ---------------------------------------------
    let classIds = [];

    if (Array.isArray(assignedClasses)) {
      const classDocs = await Class.find({
        _id: { $in: assignedClasses },
        school: currentSchool,
      });

      if (classDocs.length !== assignedClasses.length) {
        return res.status(400).json({
          success: false,
          message: "One or more assigned classes are invalid or not in your school",
        });
      }

      classIds = assignedClasses;
    }

    // ---------------------------------------------
    // SUBJECT RESOLUTION (supports multi subjects)
    // ---------------------------------------------
    let subjectIds = [];

    const incomingSubjects = Array.isArray(subjects) ? subjects : (subjects ? [subjects] : []);

    for (let sub of incomingSubjects) {
      let subjDoc = null;

      // If direct ObjectId
      if (/^[0-9a-fA-F]{24}$/.test(sub)) {
        subjDoc = await Subject.findById(sub);
      }

      // Try match by name or alias
      if (!subjDoc) {
        const sName = sub.toString().trim().toUpperCase();
        subjDoc = await Subject.findOne({
          school: currentSchool,
          $or: [
            { name: sName },
            { shortName: sName },
            { aliases: sName }
          ]
        });
      }

      // Create new subject if not found
      if (!subjDoc) {
        const normalized = sub.toString().trim().toUpperCase();
        subjDoc = await Subject.create({
          school: currentSchool,
          name: normalized,
          shortName: normalized,
          aliases: []
        });
      }

      subjectIds.push(subjDoc._id);
    }

    // ---------------------------------------------
    // Create User
    // ---------------------------------------------
    const user = new User({
      name,
      email,
      password,
      role: "teacher",
      school: currentSchool,
    });
    await user.save();

    // ---------------------------------------------
    // Create Teacher Profile
    // ---------------------------------------------
    const teacher = new Teacher({
      user: user._id,
      assignedClasses: classIds,
      subjects: subjectIds,
      phone: phone || "",
      bio: bio || "",
      school: currentSchool,
    });
    await teacher.save();

    // Sync teacher to class teachers list
    if (classIds.length > 0) {
      await Class.updateMany(
        { _id: { $in: classIds } },
        { $addToSet: { teachers: user._id } }
      );
    }

    // Send notifications
    try {
      await Notification.create({
        sender: req.user._id,
        recipientUsers: [user._id],
        message: `🎉 Welcome ${name}! Your teacher account has been created.`,
        school: currentSchool
      });

      const admins = await User.find({ role: "admin", school: currentSchool });
      if (admins.length > 0) {
        await Notification.create({
          sender: req.user._id,
          recipientUsers: admins.map(a => a._id),
          message: `📢 New teacher "${name}" has been added.`,
          school: currentSchool,
        });
      }
    } catch (err) {
      console.error("Notification send failed:", err);
    }

    const populatedTeacher = await Teacher.findById(teacher._id)
      .populate("user", "name email")
      .populate("assignedClasses", "name")
      .populate("subjects", "name shortName")
      .lean();

    res.status(201).json({
      success: true,
      message: "Teacher created successfully",
      teacher: populatedTeacher
    });

  } catch (err) {
    console.error("Teacher creation error:", err);
    res.status(500).json({
      success: false,
      message: "Error creating teacher",
      error: err.message
    });
  }
};



// ====================================================================================
//  GET ALL TEACHERS
// ====================================================================================
exports.getAllTeachers = async (req, res) => {
  try {
    const teachers = await Teacher.find({ school: req.user.school })
      .populate("user", "name email")
      .populate("assignedClasses", "name")
      .populate("subjects", "name shortName")
      .populate("school", "name schoolType");

    const valid = teachers.filter(t => t.user != null);

    res.json({
      success: true,
      count: valid.length,
      teachers: valid
    });

  } catch (err) {
    console.error("Error fetching teachers:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching teachers",
      error: err.message
    });
  }
};



// ====================================================================================
//  GET ONE TEACHER BY ID
// ====================================================================================
exports.getTeacherById = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({
      _id: req.params.id,
      school: req.user.school
    })
      .populate("user", "name email role")
      .populate("assignedClasses", "name")
      .populate("subjects", "name shortName")
      .populate("school", "name schoolType");

    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found",
      });
    }

    res.json({ success: true, teacher });

  } catch (err) {
    console.error("Error fetching teacher:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching teacher",
      error: err.message
    });
  }
};



// ====================================================================================
//  UPDATE TEACHER (multi-subject support)
// ====================================================================================
exports.updateTeacher = async (req, res) => {
  try {
    const { name, email, phone, bio, assignedClasses, subjects } = req.body;
    const teacherId = req.params.id;
    const currentSchool = req.user.school;

    const teacher = await Teacher.findOne({ _id: teacherId, school: currentSchool });
    if (!teacher) return res.status(404).json({ success: false, message: "Teacher not found" });

    const user = await User.findOne({ _id: teacher.user, school: currentSchool });
    if (!user) return res.status(404).json({ success: false, message: "Linked user not found" });

    // Update user fields
    if (name) user.name = name;
    if (email) user.email = email;
    await user.save();

    // Update teacher fields
    if (phone) teacher.phone = phone;
    if (bio) teacher.bio = bio;

    // Update subjects
    if (subjects) {
      teacher.subjects = Array.isArray(subjects) ? subjects : [subjects];
    }

    // Update assigned classes (sync Class.teachers)
    if (Array.isArray(assignedClasses)) {
      const classDocs = await Class.find({
        _id: { $in: assignedClasses },
        school: currentSchool
      });

      if (classDocs.length !== assignedClasses.length) {
        return res.status(400).json({
          success: false,
          message: "One or more assigned classes are invalid"
        });
      }

      const prevClasses = teacher.assignedClasses.map(id => id.toString());
      const newClasses = assignedClasses;

      const removed = prevClasses.filter(id => !newClasses.includes(id));
      const added = newClasses.filter(id => !prevClasses.includes(id));

      if (removed.length > 0) {
        await Class.updateMany(
          { _id: { $in: removed } },
          { $pull: { teachers: user._id } }
        );
      }

      if (added.length > 0) {
        await Class.updateMany(
          { _id: { $in: added } },
          { $addToSet: { teachers: user._id } }
        );
      }

      teacher.assignedClasses = newClasses;
    }

    await teacher.save();

    const populatedTeacher = await Teacher.findById(teacher._id)
      .populate("subjects", "name shortName");

    res.json({
      success: true,
      message: "Teacher updated successfully",
      teacher: {
        ...populatedTeacher.toObject(),
        user: {
          _id: user._id,
          name: user.name,
          email: user.email
        }
      }
    });

  } catch (err) {
    console.error("Teacher update error:", err);
    res.status(500).json({
      success: false,
      message: "Error updating teacher",
      error: err.message
    });
  }
};



// ====================================================================================
//  DELETE TEACHER
// ====================================================================================
exports.deleteTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({
      _id: req.params.id,
      school: req.user.school,
    });

    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found",
      });
    }

    await User.findByIdAndDelete(teacher.user);
    await Teacher.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Teacher and user account deleted successfully"
    });

  } catch (err) {
    console.error("Error deleting teacher:", err);
    res.status(500).json({
      success: false,
      message: "Error deleting teacher",
      error: err.message
    });
  }
};



// ====================================================================================
//  GET TEACHER STUDENTS
// ====================================================================================
exports.getMyStudents = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({
      user: req.user._id,
      school: req.user.school
    });

    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher profile not found"
      });
    }

    const students = await Student.find({
      class: { $in: teacher.assignedClasses },
      school: req.user.school
    })
      .populate("user", "name email")
      .populate("class", "name");

    res.json({
      success: true,
      assignedClasses: teacher.assignedClasses,
      totalStudents: students.length,
      students,
    });

  } catch (err) {
    console.error("Error fetching students:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching students",
      error: err.message
    });
  }
};



// ====================================================================================
//  GET TEACHER BY USER ID
// ====================================================================================
exports.getTeacherByUser = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({ user: req.params.userId })
      .populate("assignedClasses", "name")
      .populate("subjects", "name shortName")
      .populate("school", "name schoolType")
      .populate("user", "name email role");

    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found"
      });
    }

    res.json({ success: true, teacher });

  } catch (err) {
    console.error("Error fetching teacher by user:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching teacher by user",
      error: err.message
    });
  }
};



// ====================================================================================
//  GET CLASSES WHERE TEACHER IS CLASS TEACHER
// ====================================================================================
exports.getTeacherClasses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) {
      return res.status(400).json({
        success: false,
        message: "teacherId is required"
      });
    }

    const teacher = await Teacher.findById(teacherId).populate("user", "_id");
    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found"
      });
    }

    const assigned = await Class.find({
      classTeacher: teacher.user._id
    }).select("name");

    res.json({
      success: true,
      totalClasses: assigned.length,
      classes: assigned
    });

  } catch (err) {
    console.error("Error fetching teacher classes:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching teacher classes",
      error: err.message
    });
  }
};
