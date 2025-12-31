const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const Student = require('../models/Student');
const User = require('../models/User');
const mongoose = require('mongoose');
const Teacher = require('../models/Teacher');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();


// 🔔 Reusable Push Sender
async function sendPush(userIds, title, body) {
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
    data: { type: "announcement" }
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
  }
}

// ==============================
// Helper: Resolve class names safely
// ==============================
function resolveClassNames(cls) {
  if (!cls) {
    return {
      className: "Unassigned",
      classDisplayName: null,
    };
  }

  const className = cls.name || "Unassigned";

  const classDisplayName =
    cls.displayName ||
    (cls.stream ? `${cls.name}${cls.stream}` : null);

  return { className, classDisplayName };
}


exports.createAnnouncement = async (req, res) => {
  try {
    const { title, message, targetRoles, classId } = req.body;
    const schoolId = req.user.school;
    const creator = req.user;

    if (!schoolId) {
      return res.status(400).json({ message: 'School info missing in user token.' });
    }

    // -----------------------------
    // TEACHER VALIDATION
    // -----------------------------
    if (creator.role === 'teacher') {
      if (!classId) {
        return res.status(400).json({ message: 'Teachers must specify a classId.' });
      }

      const teacherDoc = await Teacher.findOne({ user: creator._id })
        .select('assignedClass assignedClasses')
        .lean();

      if (!teacherDoc) {
        return res.status(403).json({ message: 'No teacher record found.' });
      }

      const teacherClasses = [];
      if (teacherDoc.assignedClass) teacherClasses.push(String(teacherDoc.assignedClass));
      if (Array.isArray(teacherDoc.assignedClasses)) teacherClasses.push(...teacherDoc.assignedClasses.map(String));

      if (!teacherClasses.includes(String(classId))) {
        return res.status(403).json({ message: 'You cannot create an announcement for this class.' });
      }
    }

    // -----------------------------
    // ROLE RESOLUTION
    // -----------------------------
    let resolvedRoles = [];
    if (creator.role === "teacher") {
      resolvedRoles = []; 
    } else if (creator.role === "admin") {
      resolvedRoles = classId
        ? ["student", "parent"]
        : ["student", "parent", "teacher"];
    }

    // -----------------------------
    // CREATE ANNOUNCEMENT
    // -----------------------------
    const newAnnouncement = new Announcement({
      title: title || (creator.role === 'teacher' ? 'Class Announcement' : 'Announcement'),
      message,
      targetRoles: resolvedRoles,
      class: classId || null,
      sentBy: creator._id,
      school: schoolId,
    });

    await newAnnouncement.save();

    // -----------------------------
    // NOTIFICATION CREATION
    // -----------------------------
    let recipientUsers = [];

    if (creator.role === 'teacher') {
      const students = await Student.find({
        class: classId,
        school: schoolId
      }).select("user parent parentIds").lean();

      students.forEach(s => {
        if (s.user) recipientUsers.push(String(s.user));
        if (s.parent) recipientUsers.push(String(s.parent));
        if (Array.isArray(s.parentIds)) {
          s.parentIds.forEach(pid => recipientUsers.push(String(pid)));
        }
      });

      recipientUsers = [...new Set(recipientUsers)];

      if (recipientUsers.length > 0) {
        await Notification.create({
          title: "New Class Announcement",
          sender: creator._id,
          school: schoolId,
          message: `Announcement: ${title || 'Class announcement'}`,
          type: "announcement",
          audience: "class",
          class: classId,
          recipientUsers,
          recipientRoles: [],
          announcementId: newAnnouncement._id
        });
      }
    }

    if (creator.role === 'admin') {
      // Admin broadcasts by roles
      const users = await User.find({
        school: schoolId,
        role: { $in: resolvedRoles },
      }).select("_id");

      recipientUsers = users.map(u => String(u._id));

      await Notification.create({
        title: classId ? "New Class Announcement" : "New School Announcement",
        sender: creator._id,
        school: schoolId,
        message: `Announcement: ${title || 'New announcement'}`,
        type: "announcement",
        audience: classId ? "class" : "all",
        class: classId || null,
        recipientRoles: resolvedRoles,
        announcementId: newAnnouncement._id
      });
    }

    // -----------------------------
    // 🔔 PUSH NOTIFICATION
    // -----------------------------
    if (recipientUsers.length > 0) {
      await sendPush(
        recipientUsers,
        "New Announcement",
        title || "You have a new announcement"
      );
    }

    // -----------------------------
    // RESPONSE
    // -----------------------------
    return res.status(201).json({
      message: 'Announcement created successfully',
      announcement: newAnnouncement,
    });

  } catch (err) {
    console.error('❌ Error creating announcement:', err);
    res.status(500).json({ message: 'Error creating announcement', error: err.message });
  }
};


/**
 * Students/Parents:
 * - Create an Announcement targeted to teachers/admins (no Notification docs created here).
 * - If parent has multiple classes we create a school-level announcement (class=null).
 */
exports.sendNotificationByStudentOrParent = async (req, res) => {
  try {
    const { message, title } = req.body;
    const user = req.user;

    if (!user || !user.role) {
      return res.status(401).json({ message: 'Invalid user.' });
    }

    let classes = [];
    if (user.role === 'student') {
      const student = await Student.findOne({ user: user._id }).select('class');
      if (student?.class) classes = [student.class];
    } else if (user.role === 'parent') {
      const students = await Student.find({ parent: user._id }).select('class');
      classes = students.map(s => s.class).filter(Boolean);
    }

    if (!classes || classes.length === 0) {
      return res.status(400).json({ message: 'No class found.' });
    }

    const classForAnnouncement = classes.length === 1 ? classes[0] : null;

    const newAnnouncement = new Announcement({
      title: title || (user.role === 'student' ? 'Message from student' : 'Message from parent'),
      message: `From ${user.name}: ${message}`,
      targetRoles: ['teacher', 'admin'],
      class: classForAnnouncement,
      sentBy: user._id,
      school: user.school,
    });

    await newAnnouncement.save();

    res.status(201).json({
      message: 'Announcement created.',
      announcement: newAnnouncement
    });
  } catch (err) {
    console.error('Error creating announcement from student/parent:', err);
    res.status(500).json({ message: 'Error creating announcement', error: err.message });
  }
};

/**
 * Get announcements for the authenticated user.
 * Students/parents: get role and class targeted announcements (FIXED - strict class filtering)
 * Teachers: will naturally get announcements targeted to 'teacher' or to classes they teach
 * Admins: get all school announcements.
 */
exports.getMyAnnouncements = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const userRole = req.user.role;
    const userId = req.user._id;

    const studentId = req.query.studentId || req.body.studentId;
    const childId = req.query.childId || req.body.childId;

    let targetStudent = null;
    let classIds = [];

    // ----------------------------------------------------------
    // 🎓 STUDENT → strictly their own class
    // ----------------------------------------------------------
    if (userRole === "student") {
      targetStudent = await Student.findOne({
        user: userId,
        school: schoolId
      }).populate("class user", "name stream displayName").lean();

      if (!targetStudent) {
        return res.status(404).json({ message: "Student record not found." });
      }

      classIds = [String(targetStudent.class._id)];
    }

    // ----------------------------------------------------------
    // 👪 PARENT → strict selection of ONE child
    // ----------------------------------------------------------
    if (userRole === "parent") {
      const targetId = childId || studentId;
      if (!targetId) {
        return res.status(400).json({ message: "Missing childId or studentId" });
      }

      targetStudent = await Student.findOne({
        _id: targetId,
        school: schoolId,
        $or: [
          { parent: userId },
          { parentIds: { $in: [userId] } }
        ]
      }).populate("class user", "name stream displayName").lean();

      if (!targetStudent) {
        return res.status(403).json({ message: "Unauthorized childId" });
      }

      classIds = [String(targetStudent.class._id)];
    }

    // ----------------------------------------------------------
    // 🧑‍🏫 TEACHER → classes they teach
    // ----------------------------------------------------------
    if (userRole === "teacher") {
      const teacherDoc = await Teacher.findOne({
        user: userId,
        school: schoolId
      }).select("assignedClass assignedClasses").lean();

      if (teacherDoc?.assignedClass) {
        classIds.push(String(teacherDoc.assignedClass));
      }

      if (Array.isArray(teacherDoc?.assignedClasses)) {
        classIds.push(...teacherDoc.assignedClasses.map(c => String(c)));
      }
    }

    // ----------------------------------------------------------
    // 🔍 BUILD FILTER (STRICT – NO CLASS LEAKS)
    // ----------------------------------------------------------
    let filter = {
      school: schoolId,
      isDeleted: { $ne: true },
      $and: []
    };

    // ----------------------------------------------------------
    // 🎓 STUDENT FILTER
    // ----------------------------------------------------------
    if (userRole === "student") {
      filter.$and.push({
        $or: [
          { class: { $in: classIds } }, // 🔒 class-scoped ONLY
          {
            class: null,
            targetRoles: { $in: ["student", "all", "everyone"] }
          }
        ]
      });
    }

    // ----------------------------------------------------------
    // 👪 PARENT FILTER
    // ----------------------------------------------------------
    if (userRole === "parent") {
      filter.$and.push({
        $or: [
          { class: { $in: classIds } }, // 🔒 class-scoped ONLY
          {
            class: null,
            targetRoles: { $in: ["parent", "all", "everyone"] }
          }
        ]
      });
    }

    // ----------------------------------------------------------
    // 🧑‍🏫 TEACHER FILTER
    // ----------------------------------------------------------
    if (userRole === "teacher") {
      filter.$and.push({
        $or: [
          { class: { $in: classIds } }, // 🔒 class-scoped ONLY
          { sentBy: userId },
          {
            class: null,
            targetRoles: { $in: ["teacher", "all", "everyone"] }
          }
        ]
      });
    }

    // ----------------------------------------------------------
    // 📥 FETCH ANNOUNCEMENTS
    // ----------------------------------------------------------
    let announcements = await Announcement.find(filter)
      .sort({ createdAt: -1 })
      .populate("sentBy", "name role")
      .populate("class", "name stream displayName")
      .lean();

    // ----------------------------------------------------------
    // 🔔 NOTIFICATION ENRICHMENT
    // ----------------------------------------------------------
    const announcementIds = announcements.map(a => a._id);

    const notifications = await Notification.find({
      school: schoolId,
      type: "announcement",
      announcementId: { $in: announcementIds },
      $or: [
        { recipientUsers: userId },
        { recipientRoles: { $in: [userRole] } }
      ]
    }).select("announcementId isRead").lean();

    const notifMap = {};
    notifications.forEach(n => {
      notifMap[String(n.announcementId)] = n;
    });

    announcements = announcements.map(a => ({
      ...a,
      notification: notifMap[String(a._id)] || null
    }));

    // ----------------------------------------------------------
    // 🔔 AUTO MARK AS READ
    // ----------------------------------------------------------
    await Notification.updateMany(
      {
        announcementId: { $in: announcementIds },
        recipientUsers: userId,
        isRead: false
      },
      { $set: { isRead: true } }
    );

    // ----------------------------------------------------------
    // 🧩 CLASS NAME NORMALIZATION (BASIC 9A FIX)
    // ----------------------------------------------------------
    announcements = announcements.map(a => {
      const { className, classDisplayName } = resolveClassNames(a.class);
      return { ...a, className, classDisplayName };
    });

    // ----------------------------------------------------------
    // 📋 STUDENT / PARENT ENRICHMENT
    // ----------------------------------------------------------
    if (userRole === "student" || userRole === "parent") {
      announcements = announcements.map(a => ({
        ...a,
        childId: targetStudent?._id,
        childName: targetStudent?.user?.name
      }));
    }

    // ----------------------------------------------------------
    // ✅ RESPONSE
    // ----------------------------------------------------------
    return res.json({
      success: true,
      count: announcements.length,
      data: announcements
    });

  } catch (err) {
    console.error("❌ getMyAnnouncements error:", err);
    return res.status(500).json({
      message: "Error fetching announcements",
      error: err.message
    });
  }
};



/**
 * Admin/Teacher: list announcements for the school (with optional filters).
 * - Admins see everything.
 * - Teachers are scoped to announcements relevant to them (classes they teach or role=teacher/all).
 */
exports.getAnnouncementsForSchool = async (req, res) => {
  try {
    const schoolId = req.user.school;
    if (!schoolId) return res.status(400).json({ message: 'School info missing in user token.' });

    const { targetRole, classId, page = 1, limit = 50 } = req.query;
    const filter = { school: schoolId, isDeleted: { $ne: true } };

    // apply query filters (role/class) if provided
    if (targetRole) {
      const roles = String(targetRole).split(',').map(r => r.trim());
      filter.targetRoles = { $in: roles };
    }
    if (classId) filter.class = classId;

    // If requester is a teacher, scope results to classes they teach OR announcements targeted to teacher/all
    if (req.user.role === 'teacher') {
      let teacherClasses = req.user.classes;
      if (!Array.isArray(teacherClasses) || teacherClasses.length === 0) {
        const teacher = await User.findById(req.user._id).select('classes').lean();
        teacherClasses = teacher?.classes || [];
      }

      // Build teacher-specific OR: targeted to teacher/all OR class in teacherClasses
      const teacherOr = [
        { targetRoles: { $in: ['teacher', 'all', 'everyone'] } }
      ];
      if (teacherClasses.length > 0) teacherOr.push({ class: { $in: teacherClasses } });

      // combine with existing filter by wrapping in $and
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: teacherOr });
    }

    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1);

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Math.max(parseInt(limit, 10), 1))
        .populate('sentBy', 'name role')
        .populate('class', 'name')
        .lean(),
      Announcement.countDocuments(filter)
    ]);

    res.json({
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      },
      data: announcements
    });
  } catch (err) {
    console.error('Error fetching school announcements:', err);
    res.status(500).json({ message: 'Error fetching announcements', error: err.message });
  }
};

/**
 * Fetch a single announcement (ensure it belongs to the same school).
 * Teachers are allowed to fetch it only if it's relevant to them (class they teach OR targeted to teacher/all).
 */
exports.getAnnouncementById = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;
    if (!schoolId) return res.status(400).json({ message: 'School info missing in user token.' });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid announcement id.' });
    }

    const announcement = await Announcement.findOne({ _id: id, school: schoolId, isDeleted: { $ne: true } })
      .populate('sentBy', 'name role')
      .populate('class', 'name')
      .lean();

    if (!announcement) return res.status(404).json({ message: 'Announcement not found.' });

    // If requester is teacher, ensure relevance
    if (req.user.role === 'teacher') {
      let teacherClasses = req.user.classes;
      if (!Array.isArray(teacherClasses) || teacherClasses.length === 0) {
        const teacher = await User.findById(req.user._id).select('classes').lean();
        teacherClasses = teacher?.classes || [];
      }

      const targetsTeacher = Array.isArray(announcement.targetRoles)
        ? announcement.targetRoles.includes('teacher') || announcement.targetRoles.includes('all') || announcement.targetRoles.includes('everyone')
        : ['teacher', 'all', 'everyone'].includes(announcement.targetRoles);

      const classIsOurs = announcement.class && teacherClasses.some(c => String(c) === String(announcement.class._id));

      if (!targetsTeacher && !classIsOurs) {
        return res.status(403).json({ message: 'You are not allowed to view this announcement.' });
      }
    }

    // If requester is student, ensure it's for their class or school-wide for students
    if (req.user.role === 'student') {
      const student = await Student.findOne({ user: req.user._id, school: schoolId });
      if (!student) return res.status(404).json({ message: 'Student record not found.' });

      const isForTheirClass = announcement.class && String(announcement.class._id) === String(student.class);
      const isSchoolWideForStudents = !announcement.class && 
        Array.isArray(announcement.targetRoles) && 
        announcement.targetRoles.some(role => ['student', 'all', 'everyone'].includes(role));

      if (!isForTheirClass && !isSchoolWideForStudents) {
        return res.status(403).json({ message: 'You are not allowed to view this announcement.' });
      }
    }

    // If requester is parent, ensure it's for their child's class or school-wide for parents
    if (req.user.role === 'parent') {
      const { childId, studentId } = req.query;
      const targetId = childId || studentId;
      
      if (!targetId) {
        return res.status(400).json({ message: 'Missing childId or studentId for parent access.' });
      }

      const student = await Student.findOne({
        _id: targetId,
        school: schoolId,
        $or: [
          { parent: req.user._id },
          { parentIds: { $in: [req.user._id] } }
        ]
      });

      if (!student) return res.status(403).json({ message: 'Unauthorized access to student record.' });

      const isForTheirClass = announcement.class && String(announcement.class._id) === String(student.class);
      const isSchoolWideForParents = !announcement.class && 
        Array.isArray(announcement.targetRoles) && 
        announcement.targetRoles.some(role => ['parent', 'all', 'everyone'].includes(role));

      if (!isForTheirClass && !isSchoolWideForParents) {
        return res.status(403).json({ message: 'You are not allowed to view this announcement.' });
      }
    }

    res.json(announcement);
  } catch (err) {
    console.error('Error fetching announcement by id:', err);
    res.status(500).json({ message: 'Error fetching announcement', error: err.message });
  }
};

/**
 * Update an announcement (admin or owning teacher)
 */
exports.updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid announcement id.' });
    }

    const announcement = await Announcement.findOne({ _id: id, school: user.school, isDeleted: { $ne: true } });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found.' });

    if (user.role === 'teacher' && String(announcement.sentBy) !== String(user._id)) {
      return res.status(403).json({ message: 'You are not allowed to edit this announcement.' });
    }

    if (updates.class && user.role !== 'admin') {
      return res.status(403).json({ message: 'Teachers cannot change the class.' });
    }

    const allowedForAll = ['title', 'message', 'targetRoles'];
    const allowedForAdminOnly = ['class'];

    Object.keys(updates).forEach(key => {
      if (allowedForAll.includes(key) || (user.role === 'admin' && allowedForAdminOnly.includes(key))) {
        announcement[key] = updates[key];
      }
    });

    announcement.updatedAt = new Date();
    await announcement.save();

    // CREATE NOTIFICATION
    const notif = await Notification.create({
      title: "Announcement Updated",
      sender: user._id,
      school: user.school,
      message: `Announcement updated: ${announcement.title}`,
      type: "announcement",
      audience: announcement.class ? "class" : "all",
      class: announcement.class || null,
      recipientRoles: announcement.class ? ["student", "parent"] : ["student", "parent", "teacher"],
      announcementId: announcement._id
    });

    // GET RECIPIENT USERS (from announcement)
    let recipientUsers = [];

    if (announcement.class) {
      const students = await Student.find({
        class: announcement.class,
        school: user.school
      }).select("user parent parentIds");

      students.forEach(s => {
        if (s.user) recipientUsers.push(String(s.user));
        if (s.parent) recipientUsers.push(String(s.parent));
        if (Array.isArray(s.parentIds))
          s.parentIds.forEach(pid => recipientUsers.push(String(pid)));
      });
    } else {
      const users = await User.find({
        school: user.school,
        role: { $in: ["student", "parent", "teacher"] }
      }).select("_id");

      recipientUsers = users.map(u => String(u._id));
    }

    recipientUsers = [...new Set(recipientUsers)];

    // 🔔 PUSH
    await sendPush(
      recipientUsers,
      "Announcement Updated",
      `Updated: ${announcement.title}`
    );

    const populated = await Announcement.findById(announcement._id)
      .populate('sentBy', 'name role')
      .populate('class', 'name')
      .lean();

    res.json({ message: 'Announcement updated', announcement: populated });
  } catch (err) {
    console.error('Error updating announcement:', err);
    res.status(500).json({ message: 'Error updating announcement', error: err.message });
  }
};


/**
 * Soft-delete an announcement (admin or owning teacher)
 */
exports.softDeleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid announcement id.' });
    }

    const announcement = await Announcement.findOne({ _id: id, school: user.school, isDeleted: { $ne: true } });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found.' });

    if (user.role === 'teacher' && String(announcement.sentBy) !== String(user._id)) {
      return res.status(403).json({ message: 'You are not allowed to delete this announcement.' });
    }

    announcement.isDeleted = true;
    announcement.deletedAt = new Date();
    announcement.deletedBy = user._id;
    await announcement.save();

    // NOTIFICATION
    await Notification.create({
      title: "Announcement Deleted",
      sender: user._id,
      school: user.school,
      message: `Announcement deleted: ${announcement.title}`,
      type: "announcement",
      audience: announcement.class ? "class" : "all",
      class: announcement.class || null,
      recipientRoles: announcement.class ? ["student", "parent"] : ["student", "parent", "teacher"],
      announcementId: announcement._id
    });

    // FIND RECIPIENTS FOR PUSH
    let recipientUsers = [];

    if (announcement.class) {
      const students = await Student.find({
        class: announcement.class,
        school: user.school
      }).select("user parent parentIds");

      students.forEach(s => {
        if (s.user) recipientUsers.push(String(s.user));
        if (s.parent) recipientUsers.push(String(s.parent));
        if (Array.isArray(s.parentIds)) {
          s.parentIds.forEach(pid => recipientUsers.push(String(pid)));
        }
      });
    } 
    else {
      const users = await User.find({
        school: user.school,
        role: { $in: ["student", "parent", "teacher"] }
      }).select("_id");

      recipientUsers = users.map(u => String(u._id));
    }

    recipientUsers = [...new Set(recipientUsers)];

    // 🔔 PUSH
    await sendPush(
      recipientUsers,
      "Announcement Deleted",
      announcement.title
    );

    res.json({ message: "Announcement soft-deleted", announcementId: announcement._id });
  } catch (err) {
    console.error("Error soft-deleting announcement:", err);
    res.status(500).json({ message: "Error deleting announcement", error: err.message });
  }
};
