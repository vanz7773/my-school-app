const Assignment = require('../models/Assignment');
const Class = require('../models/Class');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();

// ==============================
// Helper: Resolve class names (Assignments = class-based)
// ==============================
function resolveAssignmentClassNames(cls) {
  if (!cls) {
    return {
      className: "Unassigned",
      classDisplayName: null
    };
  }

  const className = cls.name || "Unassigned";

  const classDisplayName =
    cls.displayName ||
    (cls.stream ? `${cls.name}${cls.stream}` : cls.name);

  return { className, classDisplayName };
}

// 🔔 Reusable push sender
async function sendPush(userIds, title, body) {
  try {
    if (!Array.isArray(userIds) || userIds.length === 0) return;

    const tokens = await PushToken.find({
      userId: { $in: userIds },
      disabled: false,
    }).lean();

    const validTokens = tokens
      .map(t => t.token)
      .filter(token => Expo.isExpoPushToken(token));

    if (validTokens.length === 0) return;

    const messages = validTokens.map(token => ({
      to: token,
      sound: "default",
      title,
      body,
      data: { type: "assignment" }
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error("⚠️ sendPush failed:", err.message);
  }
}

// --------------------------------------------------------------------
// 🔍 Cache for frequently accessed data
// --------------------------------------------------------------------
const classCache = new Map();
const studentCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --------------------------------------------------------------------
// 🔧 Helper: Get class with caching
// --------------------------------------------------------------------
async function getClassWithCache(classId, schoolId) {
  const cacheKey = `class_${classId}_${schoolId}`;
  const cached = classCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const classDoc = await Class.findOne({ _id: classId, school: schoolId }).lean();
  
  if (classDoc) {
    classCache.set(cacheKey, { data: classDoc, timestamp: Date.now() });
  }
  
  return classDoc;
}

// --------------------------------------------------------------------
// 🔧 Helper: Get student with caching
// --------------------------------------------------------------------
async function getStudentWithCache(studentId, schoolId, userId = null) {
  const cacheKey = `student_${studentId}_${schoolId}_${userId || 'none'}`;
  const cached = studentCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  let query = { _id: studentId, school: schoolId };
  
  // For parent access, verify ownership
  if (userId) {
    query.$or = [
      { parent: userId },
      { parentIds: { $in: [userId] } }
    ];
  }

  const student = await Student.findOne(query).populate("class").lean();
  
  if (student) {
    studentCache.set(cacheKey, { data: student, timestamp: Date.now() });
  }
  
  return student;
}

async function createAssignmentNotification({
  title,
  sender,
  school,
  classId,
  action = 'created'
}) {
  try {
    const actionMap = {
      created: 'New Assignment',
      updated: 'Assignment Updated',
      deleted: 'Assignment Deleted'
    };

    // 1️⃣ Create MongoDB notification
    await Notification.create({
      title: `${actionMap[action]}: ${title}`,
      sender,
      school,
      message: `Assignment ${action}: ${title}`,
      type: "assignment",
      audience: "student",
      class: classId,
      recipientRoles: ["student", "parent"],
    });

    // 2️⃣ Resolve recipients (students + parents)
    const students = await Student.find({ 
      class: classId, 
      school 
    }).select("user parent parentIds").lean();

    let userIds = [];

    students.forEach(s => {
      if (s.user) userIds.push(String(s.user));
      if (s.parent) userIds.push(String(s.parent));
      if (Array.isArray(s.parentIds))
        s.parentIds.forEach(pid => userIds.push(String(pid)));
    });

    userIds = [...new Set(userIds)];

    if (userIds.length > 0) {
      // 3️⃣ Send push notification
      await sendPush(
        userIds,
        actionMap[action],
        title
      );
    }

  } catch (err) {
    console.error("⚠️ Assignment notification failure:", err);
  }
}

// --------------------------------------------------------------------
// 🗂️ Create new assignment WITH NOTIFICATION SUPPORT (Fixed & Type-Safe)
// --------------------------------------------------------------------
exports.createAssignment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { title, description, class: classId, dueDate } = req.body;
    const schoolId = req.user.school;
    const userId = req.user.id;

    if (!schoolId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing school info in token' });
    }

    // Fetch class (cached + lean)
    const classDoc = await getClassWithCache(classId, schoolId);
    if (!classDoc) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Class not found' });
    }

    // -----------------------------
    // 🛡️ TYPE-SAFE TEACHER CHECK
    // -----------------------------
    if (req.user.role === "teacher") {
      const teacherIds = (classDoc.teachers || []).map(t =>
        t.toString()
      );

      if (!teacherIds.includes(userId.toString())) {
        await session.abortTransaction();
        return res.status(403).json({
          message: "You are not assigned to this class"
        });
      }
    }

    // Create assignment
    const assignment = new Assignment({
      title,
      description,
      class: classId,
      dueDate,
      createdBy: userId,
      school: schoolId,
    });

    await assignment.save({ session });

    // Send notification asynchronously
    setImmediate(async () => {
      try {
        await createAssignmentNotification({
          title,
          sender: req.user._id,
          school: schoolId,
          classId,
          action: "created",
        });
      } catch (notifErr) {
        console.error("⚠️ createAssignment notification failed:", notifErr);
      }
    });

    await session.commitTransaction();

    res.status(201).json({
      message: "Assignment created",
      assignment,
    });

  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({
      message: "Error creating assignment",
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// --------------------------------------------------------------------
// 👨‍🏫 Get assignments for teacher
// --------------------------------------------------------------------
exports.getAssignmentsForTeacher = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const userId = req.user.id;

    // Admin gets all assignments
    if (req.user.role === 'admin') {
      const assignments = await Assignment.find({ school: schoolId })
        .populate('class', 'name displayName stream')
        .sort({ createdAt: -1 })
        .lean();

      // Normalize with class names
      const normalized = assignments.map(a => {
        const { className, classDisplayName } = resolveAssignmentClassNames(a.class);
        return { ...a, className, classDisplayName };
      });

      return res.json(normalized);
    }

    // Teacher gets assignments only from their classes
    const classes = await Class.find({ 
      school: schoolId, 
      teachers: userId 
    }).select('_id').lean();

    const classIds = classes.map(c => c._id);

    // Use aggregation for better performance
    const assignments = await Assignment.aggregate([
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId),
          class: { $in: classIds }
        }
      },
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: '$classInfo' },
      {
        $project: {
          title: 1,
          description: 1,
          dueDate: 1,
          createdAt: 1,
          class: {
            _id: '$classInfo._id',
            name: '$classInfo.name',
            displayName: '$classInfo.displayName',
            stream: '$classInfo.stream'
          }
        }
      },
      { $sort: { createdAt: -1 } }
    ]);

    // Normalize with class names
    const normalized = assignments.map(a => {
      const { className, classDisplayName } = resolveAssignmentClassNames(a.class);
      return { ...a, className, classDisplayName };
    });

    res.json(normalized);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching assignments', error: err.message });
  }
};

// --------------------------------------------------------------------
// 📚 Get assignments for a specific class
// --------------------------------------------------------------------
exports.getAssignmentsForClass = async (req, res) => {
  try {
    const { classId } = req.params;
    const schoolId = req.user.school;
    const userId = req.user.id;

    const classDoc = await getClassWithCache(classId, schoolId);
    if (!classDoc) {
      return res.status(404).json({ message: 'Class not found' });
    }

    let query = { class: classId, school: schoolId };
    
    // For teachers, restrict to their own assignments unless they're class teacher
    if (req.user.role === 'teacher') {
      const isClassTeacher = classDoc.classTeacher && 
        classDoc.classTeacher.toString() === userId;
      
      if (!isClassTeacher) {
        query.createdBy = userId;
      }
    }

    const assignments = await Assignment.find(query)
      .populate('class', 'name displayName stream')
      .sort({ createdAt: -1 })
      .lean();

    // Normalize with class names
    const normalized = assignments.map(a => {
      const { className, classDisplayName } = resolveAssignmentClassNames(a.class);
      return { ...a, className, classDisplayName };
    });

    res.json({ assignments: normalized });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching class assignments', error: err.message });
  }
};

// --------------------------------------------------------------------
// 📘 Student/Parent Assignments + Notification Binding
// --------------------------------------------------------------------
exports.getAssignmentsForStudent = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const studentUserId = req.user.id;
    const studentId = req.query.studentId || req.body.studentId;
    const childId = req.query.childId || req.body.childId;

    let targetStudent;

    // 🔍 Identify which student's assignments to fetch
    if (req.user.role === 'student') {
      const cacheKey = `student_user_${studentUserId}_${schoolId}`;
      const cached = studentCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        targetStudent = cached.data;
      } else {
        targetStudent = await Student.findOne({ 
          user: studentUserId, 
          school: schoolId 
        }).populate("class").lean();
        
        if (targetStudent) {
          studentCache.set(cacheKey, { data: targetStudent, timestamp: Date.now() });
        }
      }
    } 
    else if (req.user.role === 'parent') {
      const targetId = childId || studentId;
      if (!targetId) {
        return res.status(400).json({ message: "Missing childId or studentId" });
      }

      targetStudent = await getStudentWithCache(targetId, schoolId, req.user._id);
      
      if (!targetStudent) {
        return res.status(403).json({
          message: "Unauthorized: This child is not linked to your parent account."
        });
      }
    } 
    else if (req.user.role === "teacher" || req.user.role === "admin") {
      if (!studentId) {
        return res.status(400).json({ message: "Missing studentId for teacher/admin request" });
      }

      targetStudent = await getStudentWithCache(studentId, schoolId);
    }

    // 🧩 Validate student record
    if (!targetStudent) {
      return res.status(404).json({ message: "Student record not found" });
    }

    const classId = targetStudent.class?._id || targetStudent.class;
    if (!classId) {
      return res.status(404).json({ message: "Student is not enrolled in any class" });
    }

    // 📘 Fetch assignments and notifications in parallel
    const [assignments, notifications] = await Promise.all([
      // Get assignments
      Assignment.find({
        school: schoolId,
        class: classId
      })
        .populate("class", "name displayName stream")
        .sort({ createdAt: -1 })
        .lean(),
      
      // Get notifications (only if we have assignments)
      Assignment.find({ school: schoolId, class: classId })
        .select('_id')
        .lean()
        .then(assignmentDocs => {
          const assignmentIds = assignmentDocs.map(a => a._id);
          return Notification.find({
            school: schoolId,
            type: "assignment",
            assignmentId: { $in: assignmentIds },
            $or: [
              { recipientUsers: req.user._id },
              { recipientRoles: req.user.role }
            ]
          })
          .select("assignmentId isRead createdAt")
          .lean();
        })
    ]);

    const assignmentIds = assignments.map(a => a._id);

    // 🔔 Map notification to each assignment
    const notifMap = {};
    notifications.forEach(n => {
      notifMap[String(n.assignmentId)] = n;
    });

    // 🔔 Attach notification to each assignment + normalize class names
    const finalAssignments = assignments.map(a => {
      const { className, classDisplayName } = resolveAssignmentClassNames(a.class);
      
      return {
        ...a,
        className,
        classDisplayName,
        notification: notifMap[String(a._id)] || null
      };
    });

    // 🔔 Auto-mark assignment notifications as read in background
    setImmediate(async () => {
      try {
        await Notification.updateMany(
          {
            assignmentId: { $in: assignmentIds },
            recipientUsers: req.user._id,
            isRead: false
          },
          { $set: { isRead: true } }
        );
      } catch (updateErr) {
        console.error('⚠️ Auto-mark notifications as read failed:', updateErr);
      }
    });

    // Get class name info for response header
    const { className: studentClassName, classDisplayName: studentClassDisplayName } = 
      resolveAssignmentClassNames(targetStudent.class);

    // 📤 Response
    return res.json({
      success: true,
      studentId: targetStudent._id,
      studentName: targetStudent.name,
      class: studentClassDisplayName || studentClassName,
      assignments: finalAssignments
    });

  } catch (err) {
    console.error("❌ getAssignmentsForStudent error:", err);
    return res.status(500).json({
      message: "Error fetching assignments",
      error: err.message
    });
  }
};

// --------------------------------------------------------------------
// ✏️ Update assignment
// --------------------------------------------------------------------
exports.updateAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;
    const userId = req.user.id;
    const { title, description, dueDate } = req.body;

    const assignment = await Assignment.findOne({ _id: id, school: schoolId });
    if (!assignment) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    if (req.user.role === 'teacher' && assignment.createdBy.toString() !== userId) {
      return res.status(403).json({ message: 'Unauthorized to update this assignment' });
    }

    // Update assignment
    assignment.title = title;
    assignment.description = description;
    assignment.dueDate = dueDate;
    await assignment.save();

    // 🔔 Create notification in background
    setImmediate(async () => {
      try {
        await createAssignmentNotification({
          title,
          sender: req.user._id,
          school: schoolId,
          classId: assignment.class,
          action: 'updated'
        });
      } catch (notifErr) {
        console.error('⚠️ updateAssignment background notification failed:', notifErr);
      }
    });

    // Populate class for response
    await assignment.populate('class', 'name displayName stream');
    const { className, classDisplayName } = resolveAssignmentClassNames(assignment.class);

    res.json({ 
      message: 'Assignment updated', 
      assignment: {
        ...assignment.toObject(),
        className,
        classDisplayName
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error updating assignment', error: err.message });
  }
};

// --------------------------------------------------------------------
// ❌ Delete assignment  (with full push support)
// --------------------------------------------------------------------
exports.deleteAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;
    const userId = req.user.id;

    // 1. Find assignment
    const assignment = await Assignment.findOne({ _id: id, school: schoolId });
    if (!assignment) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    // 2. Permission check (teachers can only delete their own)
    if (req.user.role === 'teacher' && assignment.createdBy.toString() !== userId) {
      return res.status(403).json({ message: 'Unauthorized to delete this assignment' });
    }

    // 3. Notify students + parents BEFORE deletion
    setImmediate(async () => {
      try {
        await createAssignmentNotification({
          title: assignment.title,
          sender: req.user._id,
          school: schoolId,
          classId: assignment.class,
          action: 'deleted'
        });

        // 🔥 NOTE:
        // createAssignmentNotification() already handles:
        // - MongoDB Notification
        // - student/parent resolution
        // - Push notifications
      } catch (notifErr) {
        console.error('⚠️ deleteAssignment push-notification failed:', notifErr);
      }
    });

    // 4. Delete assignment
    await Assignment.deleteOne({ _id: id, school: schoolId });

    // 5. Response
    return res.json({ message: 'Assignment deleted' });

  } catch (err) {
    console.error("💥 deleteAssignment error:", err);
    return res.status(500).json({
      message: 'Error deleting assignment',
      error: err.message
    });
  }
};

// --------------------------------------------------------------------
// 👑 Admin: Get all assignments across all classes
// --------------------------------------------------------------------
exports.getAllAssignmentsForAdmin = async (req, res) => {
  try {
    const schoolId = req.user.school;
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admins only' });
    }

    // Filters
    const {
      classId,
      teacherId,
      q,
      dueFrom,
      dueTo,
      page = 1,
      limit = 20,
      sort = '-createdAt',
    } = req.query;

    const filter = { school: schoolId };

    if (classId) filter.class = classId;
    if (teacherId) filter.createdBy = teacherId;

    if (q && q.trim()) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [{ title: rx }, { description: rx }];
    }

    if (dueFrom || dueTo) {
      filter.dueDate = {};
      if (dueFrom) filter.dueDate.$gte = new Date(dueFrom);
      if (dueTo) filter.dueDate.$lte = new Date(dueTo);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Use aggregation for better performance with multiple populations
    const aggregationPipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'classes',
          localField: 'class',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: { path: '$classInfo', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          as: 'creatorInfo'
        }
      },
      { $unwind: { path: '$creatorInfo', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          title: 1,
          description: 1,
          dueDate: 1,
          createdAt: 1,
          class: {
            _id: '$classInfo._id',
            name: '$classInfo.name',
            displayName: '$classInfo.displayName',
            stream: '$classInfo.stream'
          },
          'createdBy.name': '$creatorInfo.name',
          'createdBy.role': '$creatorInfo.role'
        }
      },
      { $sort: { [sort.startsWith('-') ? sort.slice(1) : sort]: sort.startsWith('-') ? -1 : 1 } },
      { $skip: skip },
      { $limit: limitNum }
    ];

    const [items, total] = await Promise.all([
      Assignment.aggregate(aggregationPipeline),
      Assignment.countDocuments(filter),
    ]);

    // Normalize with class names
    const normalized = items.map(a => {
      const { className, classDisplayName } = resolveAssignmentClassNames(a.class);
      return { ...a, className, classDisplayName };
    });

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + normalized.length < total,
      items: normalized,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching assignments', error: err.message });
  }
};

// --------------------------------------------------------------------
// 🧹 Cache cleanup (optional - for long running processes)
// --------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  
  // Clean class cache
  for (const [key, value] of classCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      classCache.delete(key);
    }
  }
  
  // Clean student cache
  for (const [key, value] of studentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      studentCache.delete(key);
    }
  }
}, CACHE_TTL);