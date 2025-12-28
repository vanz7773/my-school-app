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
// Helper: Get class display name
// ==============================
function getClassDisplayName(cls) {
  if (!cls) return "Unknown Class";
  
  // Use displayName if available, otherwise combine name and stream
  if (cls.displayName) return cls.displayName;
  if (cls.name && cls.stream) return `${cls.name}${cls.stream}`;
  if (cls.name) return cls.name;
  
  return "Unknown Class";
}

// ==============================
// Helper: Prepare class object for response
// ==============================
function prepareClassObject(cls) {
  if (!cls) {
    return {
      _id: null,
      name: "Unknown Class",
      classDisplayName: "Unknown Class"
    };
  }
  
  return {
    _id: cls._id,
    name: cls.name || "Unknown Class",
    stream: cls.stream || null,
    classDisplayName: getClassDisplayName(cls)
  };
}

// ==============================
// Helper: Check if user is class teacher of a class
// ==============================
async function isUserClassTeacherOfClass(userId, classId, schoolId) {
  try {
    const cls = await Class.findOne({
      _id: classId,
      school: schoolId,
      classTeacher: userId
    }).select('_id');
    
    return !!cls;
  } catch (error) {
    console.error('Error checking class teacher status:', error);
    return false;
  }
}

// ==============================
// Helper: Check if user can edit timetable entry
// ==============================
async function canUserEditTimetableEntry(user, entry) {
  try {
    // User is class teacher of the entry's class
    const isClassTeacher = await isUserClassTeacherOfClass(user._id, entry.class, user.school);
    if (isClassTeacher) return true;
    
    // User is the teacher assigned to this entry
    if (entry.teacher && String(entry.teacher) === String(user._id)) return true;
    
    return false;
  } catch (error) {
    console.error('Error checking edit permission:', error);
    return false;
  }
}

// ==============================
// NEW: Get teacher's timetable classes with display-ready data
// ==============================
exports.getTeacherTimetableClasses = async (req, res) => {
  try {
    const userId = req.user._id;
    const schoolId = req.user.school;
    
    // Find teacher profile
    const teacher = await Teacher.findOne({
      user: userId,
      school: schoolId
    });
    
    if (!teacher) {
      return res.status(404).json({ 
        success: false, 
        message: 'Teacher profile not found' 
      });
    }
    
    // Find classes where teacher is class teacher or subject teacher
    const classes = await Class.find({
      school: schoolId,
      $or: [
        { classTeacher: userId },
        { teachers: userId }
      ]
    }).select('name stream displayName classTeacher');
    
    // Prepare classes for display
    const displayClasses = classes.map(cls => {
      const classObj = prepareClassObject(cls);
      return {
        ...classObj,
        isClassTeacher: cls.classTeacher && String(cls.classTeacher) === String(userId)
      };
    });
    
    res.json({
      success: true,
      classes: displayClasses,
      canEditAll: false // This can be enhanced based on permissions
    });
    
  } catch (err) {
    console.error('Error fetching teacher timetable classes:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching timetable classes',
      error: err.message
    });
  }
};

// ==============================
// Teacher: View timetable for a specific class (UPDATED)
// ==============================
exports.getTeacherClassTimetable = async (req, res) => {
  try {
    const { classId } = req.query;
    const userId = req.user._id;
    const schoolId = req.user.school;

    if (!classId) {
      return res.status(400).json({ 
        success: false, 
        message: "classId is required" 
      });
    }

    // Fetch timetable entries
    const entries = await Timetable.find({
      school: schoolId,
      class: classId
    })
    .populate("class", "name stream displayName")
    .populate("teacher", "name email");

    // Check if user is class teacher for this class
    const isClassTeacher = await isUserClassTeacherOfClass(userId, classId, schoolId);
    
    // Get class info for display
    const cls = await Class.findById(classId).select('name stream displayName');
    const classInfo = prepareClassObject(cls);

    // Prepare timetable entries with display-ready data
    const timetable = await Promise.all(entries.map(async (entry) => {
      const entryObj = entry.toObject();
      
      // Check if user can edit this specific entry
      const canEdit = await canUserEditTimetableEntry(req.user, entry);
      
      return {
        ...entryObj,
        class: prepareClassObject(entry.class),
        teacher: entry.teacher ? {
          _id: entry.teacher._id,
          name: entry.teacher.name,
          email: entry.teacher.email
        } : null,
        canEdit,
        isClassTeacher: isClassTeacher
      };
    }));

    res.json({
      success: true,
      timetable,
      class: classInfo,
      isClassTeacher,
      canEditAll: isClassTeacher
    });

  } catch (err) {
    console.error('Error fetching class timetable:', err);
    res.status(500).json({
      success: false,
      message: "Error fetching timetable",
      error: err.message
    });
  }
};

// ==============================
// Teacher: View own timetable (UPDATED with display-ready data)
// ==============================
exports.getTeacherTimetable = async (req, res) => {
  try {
    const userId = req.user._id;
    const schoolId = req.user.school;
    
    // Find teacher profile
    const teacher = await Teacher.findOne({
      user: userId,
      school: schoolId
    });
    
    if (!teacher) {
      return res.status(404).json({ 
        success: false, 
        message: 'Teacher profile not found' 
      });
    }

    // Find classes where teacher is either classTeacher or subject teacher
    const classes = await Class.find({
      school: schoolId,
      $or: [
        { classTeacher: userId },
        { teachers: userId }
      ]
    }).select('_id');

    const classIds = classes.map(c => c._id);

    // Fetch timetable entries
    const entries = await Timetable.find({
      school: schoolId,
      $or: [
        { teacher: userId },
        { class: { $in: classIds } }
      ]
    })
    .populate('class', 'name stream displayName')
    .populate('teacher', 'name email');

    // Prepare timetable entries with display-ready data
    const timetable = await Promise.all(entries.map(async (entry) => {
      const entryObj = entry.toObject();
      
      // Check if user can edit this specific entry
      const canEdit = await canUserEditTimetableEntry(req.user, entry);
      
      // Check if user is class teacher for this entry's class
      const isEntryClassTeacher = await isUserClassTeacherOfClass(userId, entry.class._id, schoolId);
      
      return {
        ...entryObj,
        class: prepareClassObject(entry.class),
        teacher: entry.teacher ? {
          _id: entry.teacher._id,
          name: entry.teacher.name,
          email: entry.teacher.email
        } : null,
        canEdit,
        isClassTeacher: isEntryClassTeacher
      };
    }));

    res.json({ 
      success: true, 
      timetable 
    });

  } catch (err) {
    console.error('Error fetching teacher timetable:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching teacher timetable',
      error: err.message
    });
  }
};

// ==============================
// UPDATED: Create timetable entry (returns display-ready data)
// ==============================
exports.createTimetableEntry = async (req, res) => {
  try {
    const { classId, teacherId, subject, day, startTime, endTime } = req.body;
    const schoolId = req.user.school;

    // Validate class
    const cls = await Class.findOne({ _id: classId, school: schoolId });
    if (!cls) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }

    // Resolve teacher user id
    const resolvedTeacherUserId = await resolveTeacherUserId(teacherId, schoolId);
    if (!resolvedTeacherUserId) {
      return res.status(404).json({ 
        success: false, 
        message: 'Teacher not found' 
      });
    }

    const newEntry = new Timetable({
      class: classId,
      teacher: resolvedTeacherUserId,
      subject,
      day,
      startTime,
      endTime,
      school: schoolId
    });

    await newEntry.save();

    // Populate and return display-ready data
    const populated = await Timetable.findById(newEntry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');
    
    const entryObj = populated.toObject();
    const canEdit = await canUserEditTimetableEntry(req.user, populated);
    const isEntryClassTeacher = await isUserClassTeacherOfClass(req.user._id, classId, schoolId);

    res.status(201).json({
      success: true,
      message: 'Timetable entry created',
      timetable: {
        ...entryObj,
        class: prepareClassObject(populated.class),
        teacher: populated.teacher ? {
          _id: populated.teacher._id,
          name: populated.teacher.name,
          email: populated.teacher.email
        } : null,
        canEdit,
        isClassTeacher: isEntryClassTeacher
      }
    });
    
  } catch (err) {
    console.error('Error creating timetable entry:', err);
    res.status(500).json({
      success: false,
      message: 'Error creating entry',
      error: err.message
    });
  }
};

// ==============================
// UPDATED: Class Teacher: Create timetable for their own class
// ==============================
exports.createClassTeacherTimetable = async (req, res) => {
  try {
    const { classId, subject, day, startTime, endTime } = req.body;
    const userId = req.user._id;
    const schoolId = req.user.school;

    // Find teacher profile
    const teacher = await Teacher.findOne({ 
      user: userId, 
      school: schoolId 
    });
    
    if (!teacher) {
      return res.status(404).json({ 
        success: false, 
        message: 'Teacher profile not found' 
      });
    }

    // Verify user is class teacher for this class
    const cls = await Class.findOne({
      _id: classId,
      school: schoolId,
      classTeacher: userId
    });

    if (!cls) {
      return res.status(403).json({ 
        success: false, 
        message: 'Only class teacher can create timetable for this class' 
      });
    }

    const newEntry = new Timetable({
      class: classId,
      teacher: userId,
      subject,
      day,
      startTime,
      endTime,
      school: schoolId
    });

    await newEntry.save();

    // Populate and return display-ready data
    const populated = await Timetable.findById(newEntry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');
    
    const entryObj = populated.toObject();

    res.status(201).json({
      success: true,
      message: 'Timetable entry created successfully',
      timetable: {
        ...entryObj,
        class: prepareClassObject(populated.class),
        teacher: populated.teacher ? {
          _id: populated.teacher._id,
          name: populated.teacher.name,
          email: populated.teacher.email
        } : null,
        canEdit: true,
        isClassTeacher: true
      }
    });
    
  } catch (err) {
    console.error('Error creating class teacher entry:', err);
    res.status(500).json({
      success: false,
      message: 'Error creating class teacher entry',
      error: err.message
    });
  }
};

// ==============================
// UPDATED: Update timetable entry (returns display-ready data)
// ==============================
exports.updateTimetableEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, day, startTime, endTime } = req.body;
    const userId = req.user._id;
    const schoolId = req.user.school;

    const entry = await Timetable.findOne({ 
      _id: id, 
      school: schoolId 
    });
    
    if (!entry) {
      return res.status(404).json({ 
        success: false, 
        message: 'Timetable entry not found' 
      });
    }

    // Check permissions
    const canEdit = await canUserEditTimetableEntry(req.user, entry);
    if (!canEdit) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to update this entry' 
      });
    }

    // Update fields
    if (subject) entry.subject = subject;
    if (day) entry.day = day;
    if (startTime) entry.startTime = startTime;
    if (endTime) entry.endTime = endTime;

    await entry.save();

    // Populate and return display-ready data
    const populated = await Timetable.findById(entry._id)
      .populate('class', 'name stream displayName')
      .populate('teacher', 'name email');
    
    const entryObj = populated.toObject();
    const isEntryClassTeacher = await isUserClassTeacherOfClass(userId, entry.class, schoolId);

    res.json({
      success: true,
      message: 'Timetable entry updated',
      timetable: {
        ...entryObj,
        class: prepareClassObject(populated.class),
        teacher: populated.teacher ? {
          _id: populated.teacher._id,
          name: populated.teacher.name,
          email: populated.teacher.email
        } : null,
        canEdit: true,
        isClassTeacher: isEntryClassTeacher
      }
    });
    
  } catch (err) {
    console.error('Error updating timetable entry:', err);
    res.status(500).json({
      success: false,
      message: 'Error updating timetable entry',
      error: err.message
    });
  }
};

// ==============================
// UPDATED: Get classes for timetable UI
// ==============================
exports.getClassesForTimetable = async (req, res) => {
  try {
    const userId = req.user._id;
    const schoolId = req.user.school;

    // Find teacher profile
    const teacher = await Teacher.findOne({
      user: userId,
      school: schoolId
    });
    
    if (!teacher) {
      return res.status(404).json({ 
        success: false, 
        message: 'Teacher profile not found' 
      });
    }

    // Find classes where teacher is class teacher or subject teacher
    const classes = await Class.find({
      school: schoolId,
      $or: [
        { classTeacher: userId },
        { teachers: userId }
      ]
    }).select('name stream displayName classTeacher');

    // Prepare classes for display
    const displayClasses = classes.map(cls => {
      const classObj = prepareClassObject(cls);
      return {
        ...classObj,
        isClassTeacher: cls.classTeacher && String(cls.classTeacher) === String(userId)
      };
    });

    res.json({
      success: true,
      classes: displayClasses,
      canEditAll: displayClasses.some(c => c.isClassTeacher)
    });
    
  } catch (err) {
    console.error('Error fetching classes for timetable:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching classes',
      error: err.message
    });
  }
};

// ==============================
// The following endpoints remain unchanged in structure but can be updated
// similarly if they need to return display-ready data
// ==============================

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
      .populate('teacher', 'name email');

    // Convert to display-ready format
    const timetable = results.map(entry => {
      const entryObj = entry.toObject();
      return {
        ...entryObj,
        class: prepareClassObject(entry.class),
        teacher: entry.teacher ? {
          _id: entry.teacher._id,
          name: entry.teacher.name,
          email: entry.teacher.email
        } : null
      };
    });

    res.json({ success: true, results: timetable });
  } catch (err) {
    console.error('Error fetching filtered timetable:', err);
    res.status(500).json({ success: false, message: 'Error fetching timetable', error: err.message });
  }
};

// Student: View own class timetable (Scoped by school)
exports.getStudentTimetable = async (req, res) => {
  try {
    if (req.user.role !== 'student')
      return res.status(403).json({ success: false, message: 'Access denied' });

    const student = await Student.findOne({
      user: req.user._id,
      school: req.user.school
    }).populate('class', '_id name stream displayName');

    if (!student)
      return res.status(404).json({ success: false, message: 'Student not found' });

    const results = await Timetable.find({
      class: student.class._id,
      school: req.user.school
    })
      .populate('teacher', 'name email')
      .populate('class', 'name stream displayName');

    // Convert to display-ready format
    const timetable = results.map(entry => {
      const entryObj = entry.toObject();
      return {
        ...entryObj,
        class: prepareClassObject(entry.class),
        teacher: entry.teacher ? {
          _id: entry.teacher._id,
          name: entry.teacher.name,
          email: entry.teacher.email
        } : null
      };
    });

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

// Parent: View all children's timetables
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

      // Convert to display-ready format
      const normalizedTimetable = results.map(entry => {
        const entryObj = entry.toObject();
        return {
          ...entryObj,
          class: prepareClassObject(entry.class),
          teacher: entry.teacher ? {
            _id: entry.teacher._id,
            name: entry.teacher.name,
            email: entry.teacher.email
          } : null
        };
      });

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

// Class Teacher: Delete timetable entry
exports.deleteTimetableEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const schoolId = req.user.school;

    const entry = await Timetable.findOne({ 
      _id: id, 
      school: schoolId 
    });
    
    if (!entry) {
      return res.status(404).json({ 
        success: false, 
        message: 'Timetable entry not found' 
      });
    }

    // Check permissions
    const canEdit = await canUserEditTimetableEntry(req.user, entry);
    if (!canEdit) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to delete this entry' 
      });
    }

    await entry.deleteOne();
    res.json({ 
      success: true, 
      message: 'Timetable entry deleted successfully' 
    });
    
  } catch (err) {
    console.error('Error deleting timetable entry:', err);
    res.status(500).json({
      success: false,
      message: 'Error deleting timetable entry',
      error: err.message
    });
  }
};

// Get class teacher for a class
exports.getClassTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    if (!classId) return res.status(400).json({ success: false, message: 'classId is required' });

    const cls = await Class.findOne({ _id: classId, school: req.user.school })
      .populate('classTeacher', 'name email')
      .populate('teachers', 'name email');

    if (!cls) return res.status(404).json({ success: false, message: 'Class not found' });

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

// Get classes assigned to a teacher
exports.getTeacherAssignedClasses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) return res.status(400).json({ success: false, message: 'teacherId is required' });

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