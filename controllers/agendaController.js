// controllers/agendaController.js
const AgendaEvent = require('../models/AgendaEvent');
const mongoose = require('mongoose');
const Class = require('../models/Class');
const User = require('../models/User');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();

// --------------------------------------------------------------------
// 🔍 Helper: Resolve school based on user type
// --------------------------------------------------------------------
async function resolveSchoolForUser(user) {
  if (!user) {
    console.warn("⚠️ resolveSchoolForUser called with null user");
    return null;
  }

  const userId = user._id?.toString();

  // Direct school on user
  if (user.school) return user.school;

  // Student → resolve via class
  if (user.role === 'student' && user.class) {
    const classDoc = await Class.findById(user.class).populate('school');
    return classDoc?.school?._id || null;
  }

  // Parent → resolve via first child's class
  if (user.role === 'parent') {
    const populatedUser = await User.findById(userId).populate({
      path: 'children',
      populate: { path: 'class', populate: { path: 'school' } },
    });
    return populatedUser?.children?.[0]?.class?.school?._id || null;
  }

  return null;
}

// --------------------------------------------------------------------
// 🔔 Helper: resolve recipient user IDs for a class (students + teachers + parents)
// --------------------------------------------------------------------
async function resolveRecipientUsersForClass(classId, includeParents = true) {
  const recipientUsers = new Set();

  if (!classId) return [];

  // Students in class -> add their linked user IDs and collect parent refs
  let studentDocs = [];
  try {
    studentDocs = await Student.find({ class: classId })
      .select('user parent parentIds')
      .lean();
    for (const s of studentDocs) {
      if (s.user) recipientUsers.add(String(s.user));
    }
  } catch (err) {
    console.warn('resolveRecipientUsersForClass: student lookup failed', err);
  }

  // Teachers assigned to this class -> add their user IDs
  try {
    const TeacherModel = mongoose.model('Teacher');
    const teachers = await TeacherModel.find({
      $or: [
        { assignedClass: classId },
        { assignedClasses: classId }
      ]
    }).select('user').lean();

    for (const t of teachers) {
      if (t.user) recipientUsers.add(String(t.user));
    }
  } catch (err) {
    console.warn('resolveRecipientUsersForClass: teacher lookup failed', err);
  }

  // Optionally include parents of those students
  if (includeParents && Array.isArray(studentDocs) && studentDocs.length > 0) {
    try {
      const parentIds = new Set();
      for (const s of studentDocs) {
        if (s.parent) parentIds.add(String(s.parent));
        if (Array.isArray(s.parentIds)) {
          for (const pid of s.parentIds) {
            if (pid) parentIds.add(String(pid));
          }
        }
      }

      if (parentIds.size > 0) {
        const parents = await User.find({ _id: { $in: Array.from(parentIds) } })
          .select('_id')
          .lean();
        for (const p of parents) {
          if (p._id) recipientUsers.add(String(p._id));
        }
      }
    } catch (err) {
      console.warn('resolveRecipientUsersForClass: parent lookup failed', err);
    }
  }

  return Array.from(recipientUsers);
}

// --------------------------------------------------------------------
// 🧠 Helper: Build agenda filter dynamically per user role
// --------------------------------------------------------------------
function buildAgendaFilter(user, from, to) {
  const filter = { school: user.school };

  if (from && to) {
    filter.date = { $gte: new Date(from), $lte: new Date(to) };
  }

  let orConditions = [];

  // --------------------------------------------------------------------
  // STUDENT
  // --------------------------------------------------------------------
  if (user.role === "student") {
    const classId = user.class;

    orConditions.push(
      { audience: "all" },
      { audience: "student" }
    );

    if (classId) {
      const valid = mongoose.Types.ObjectId.isValid(classId)
        ? new mongoose.Types.ObjectId(classId)
        : classId;

      orConditions.push({ audience: "class", class: valid });
    }
  }

  // --------------------------------------------------------------------
  // PARENT
  // --------------------------------------------------------------------
  else if (user.role === "parent") {
    const classList = user.childClasses || [];

    const validClasses = classList
      .filter(Boolean)
      .map(cid =>
        mongoose.Types.ObjectId.isValid(cid)
          ? new mongoose.Types.ObjectId(cid)
          : cid
      );

    orConditions.push(
      { audience: "all" },
      { audience: "parent" },
      ...validClasses.map(c => ({ audience: "class", class: c }))
    );
  }

  // --------------------------------------------------------------------
  // TEACHER
  // --------------------------------------------------------------------
  else if (user.role === "teacher") {
    // Teachers ALWAYS get these
    orConditions.push(
      { audience: "all" },
      { audience: "teacher" }
    );

    // Add teacher's classes (teachingClasses should be populated in caller)
    const classList = Array.isArray(user.teachingClasses)
      ? user.teachingClasses
      : [];

    if (classList.length > 0) {
      const validClasses = classList
        .filter(Boolean)
        .map(cid =>
          mongoose.Types.ObjectId.isValid(cid)
            ? new mongoose.Types.ObjectId(cid)
            : cid
        );

      // Add agendas for each class the teacher teaches
      orConditions.push(
        ...validClasses.map(c => ({ audience: "class", class: c }))
      );
    }
  }

  // --------------------------------------------------------------------
  // ADMIN
  // --------------------------------------------------------------------
  else if (user.role === "admin") {
    return filter; // admin gets everything
  }

  // --------------------------------------------------------------------
  // CLEANUP + RETURN
  // --------------------------------------------------------------------
  // Remove duplicates
  const unique = new Map();
  for (const cond of orConditions) {
    unique.set(JSON.stringify(cond), cond);
  }

  orConditions = Array.from(unique.values());

  if (orConditions.length > 0) {
    filter.$or = orConditions;
  }

  return filter;
}

async function sendPushToUsers(userIds, title, message) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  // ✅ FORCE STRINGS (prevents ObjectId constructor crash)
  const safeUserIds = userIds.map(id => String(id));

  const tokens = await PushToken.find({
    userId: { $in: safeUserIds },
    disabled: false,
  })
    .sort({ updatedAt: -1 })
    .lean();

  const validTokens = tokens
    .map(t => t.token)
    .filter(token => Expo.isExpoPushToken(token));

  if (validTokens.length === 0) {
    console.log("⚠️ No valid Expo tokens for recipients");
    return;
  }

  const messages = validTokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body: message,
    data: { type: "agenda" },
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
  }
}




// --------------------------------------------------------------------
// 🗓️ Create a new agenda (FIXED: notifications + push)
// --------------------------------------------------------------------
exports.createAgenda = async (req, res) => {
  try {
    const { title, description, date, time, audience, classId, color, studentId } = req.body;
    const validAudiences = ["all", "teacher", "student", "parent", "class"];

    if (!validAudiences.includes(audience)) {
      return res.status(400).json({ error: "Invalid audience type" });
    }

    if (audience === "class" && !classId) {
      return res.status(400).json({ error: "classId required for class audience" });
    }

    const plainUser = req.user.toObject ? req.user.toObject() : req.user;
    const schoolId = await resolveSchoolForUser(plainUser);
    if (!schoolId) return res.status(403).json({ error: "No school linked" });

    // ------------------------------------------------------------
    // 📌 CREATE AGENDA
    // ------------------------------------------------------------
    const agenda = new AgendaEvent({
      title,
      description,
      date,
      time,
      audience,
      class: audience === "class" ? classId : null,
      color: color || getDefaultColor(audience),
      school: schoolId,
      createdBy: plainUser._id || null,
    });

    await agenda.save();

    // ------------------------------------------------------------
    // 🔔 RESOLVE RECIPIENT USERS (ONCE)
    // ------------------------------------------------------------
    let recipientUsers = [];

    // CLASS → students + parents + teachers
    if (audience === "class" && classId) {
      recipientUsers = await resolveRecipientUsersForClass(classId, true);
    }

    // TEACHER → all teachers in school
    if (audience === "teacher") {
      const teachers = await User.find({
        role: "teacher",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = teachers.map(t => String(t._id));
    }

    // STUDENT → specific student
    if (audience === "student" && studentId) {
      const s = await Student.findById(studentId)
        .select("user parent parentIds")
        .lean();

      if (s?.user) recipientUsers.push(String(s.user));
      if (s?.parent) recipientUsers.push(String(s.parent));
      if (Array.isArray(s?.parentIds)) {
        s.parentIds.forEach(pid => pid && recipientUsers.push(String(pid)));
      }
    }

    // STUDENT → whole class
    if (audience === "student" && !studentId && classId) {
      const students = await Student.find({
        class: classId,
        school: schoolId,
      }).select("user").lean();

      recipientUsers.push(
        ...students.filter(s => s.user).map(s => String(s.user))
      );
    }

    // PARENT → all parents
    if (audience === "parent") {
      const parents = await User.find({
        role: "parent",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = parents.map(p => String(p._id));
    }

    // ALL → everyone in school
    if (audience === "all") {
      const users = await User.find({ school: schoolId })
        .select("_id")
        .lean();

      recipientUsers = users.map(u => String(u._id));
    }

    recipientUsers = [...new Set(recipientUsers)];

    // ------------------------------------------------------------
    // 🔔 CREATE IN-APP NOTIFICATION (FIXED)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await Notification.create({
        title: `New Agenda: ${title}`,
        sender: req.user._id,
        school: schoolId,
        message: `New agenda: ${title}`,
        type: "agenda",
        agendaId: agenda._id, // ✅ REQUIRED
        audience,
        class: classId || null,
        recipientRoles:
          audience === "all"
            ? ["teacher", "student", "parent"]
            : audience === "teacher"
            ? ["teacher"]
            : audience === "student"
            ? ["student"]
            : audience === "parent"
            ? ["parent"]
            : [],
        recipientUsers,
      });
    }

    // ------------------------------------------------------------
    // 📣 EXPO PUSH NOTIFICATION (USES SAME RECIPIENTS)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await sendPushToUsers(
        recipientUsers,
        "New Agenda Posted",
        title
      );
    }

    // ------------------------------------------------------------
    // 📤 RESPONSE
    // ------------------------------------------------------------
    res.status(201).json(agenda);

  } catch (err) {
    console.error("💥 createAgenda error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// --------------------------------------------------------------------
// ✏️ Update an existing agenda (FIXED: notifications + push)
// --------------------------------------------------------------------
exports.updateAgenda = async (req, res) => {
  try {
    const { title, description, date, time, audience, classId, color, studentId } = req.body;
    const validAudiences = ["all", "teacher", "student", "parent", "class"];

    if (!validAudiences.includes(audience)) {
      return res.status(400).json({ error: "Invalid audience type" });
    }

    if (audience === "class" && !classId) {
      return res.status(400).json({ error: "classId required for class audience" });
    }

    const plainUser = req.user.toObject ? req.user.toObject() : req.user;
    const schoolId = await resolveSchoolForUser(plainUser);
    if (!schoolId) return res.status(403).json({ error: "No school linked" });

    // ------------------------------------------------------------
    // 📌 UPDATE AGENDA
    // ------------------------------------------------------------
    const agenda = await AgendaEvent.findOneAndUpdate(
      { _id: req.params.id, school: schoolId },
      {
        title,
        description,
        date,
        time,
        audience,
        class: audience === "class" ? classId : null,
        color: color || getDefaultColor(audience),
      },
      { new: true }
    );

    if (!agenda) {
      return res.status(404).json({ error: "Agenda not found" });
    }

    // ------------------------------------------------------------
    // 🔔 RESOLVE RECIPIENT USERS (ONCE)
    // ------------------------------------------------------------
    let recipientUsers = [];

    // CLASS → students + parents + teachers
    if (audience === "class" && classId) {
      recipientUsers = await resolveRecipientUsersForClass(classId, true);
    }

    // TEACHER → all teachers in school
    if (audience === "teacher") {
      const teachers = await User.find({
        role: "teacher",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = teachers.map(t => String(t._id));
    }

    // STUDENT → specific student
    if (audience === "student" && studentId) {
      const s = await Student.findById(studentId)
        .select("user parent parentIds")
        .lean();

      if (s?.user) recipientUsers.push(String(s.user));
      if (s?.parent) recipientUsers.push(String(s.parent));
      if (Array.isArray(s?.parentIds)) {
        s.parentIds.forEach(pid => pid && recipientUsers.push(String(pid)));
      }
    }

    // STUDENT → whole class
    if (audience === "student" && !studentId && classId) {
      const students = await Student.find({
        class: classId,
        school: schoolId,
      }).select("user").lean();

      recipientUsers.push(
        ...students.filter(s => s.user).map(s => String(s.user))
      );
    }

    // PARENT → all parents
    if (audience === "parent") {
      const parents = await User.find({
        role: "parent",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = parents.map(p => String(p._id));
    }

    // ALL → everyone in school
    if (audience === "all") {
      const users = await User.find({ school: schoolId })
        .select("_id")
        .lean();

      recipientUsers = users.map(u => String(u._id));
    }

    recipientUsers = [...new Set(recipientUsers)];

    // ------------------------------------------------------------
    // 🔔 CREATE IN-APP NOTIFICATION (FIXED)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await Notification.create({
        title: `Agenda Updated: ${title}`,
        sender: req.user._id,
        school: schoolId,
        message: `Agenda updated: ${title}`,
        type: "agenda",
        agendaId: agenda._id, // ✅ REQUIRED
        audience,
        class: classId || null,
        recipientRoles:
          audience === "all"
            ? ["teacher", "student", "parent"]
            : audience === "teacher"
            ? ["teacher"]
            : audience === "student"
            ? ["student"]
            : audience === "parent"
            ? ["parent"]
            : [],
        recipientUsers,
      });
    }

    // ------------------------------------------------------------
    // 📣 EXPO PUSH NOTIFICATION (USES SAME RECIPIENTS)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await sendPushToUsers(
        recipientUsers,
        "Agenda Updated",
        title
      );
    }

    // ------------------------------------------------------------
    // 📤 RESPONSE
    // ------------------------------------------------------------
    res.json(agenda);

  } catch (err) {
    console.error("💥 updateAgenda error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


// --------------------------------------------------------------------
// ❌ Delete an agenda (UPDATED WITH EXPO PUSH NOTIFICATIONS)
// --------------------------------------------------------------------
// --------------------------------------------------------------------
// ❌ Delete an agenda (FIXED: notifications + push)
// --------------------------------------------------------------------
exports.deleteAgenda = async (req, res) => {
  try {
    const plainUser = req.user.toObject ? req.user.toObject() : req.user;
    const schoolId = await resolveSchoolForUser(plainUser);
    if (!schoolId) {
      return res.status(403).json({ error: "No school linked" });
    }

    // ------------------------------------------------------------
    // 📌 DELETE AGENDA
    // ------------------------------------------------------------
    const agenda = await AgendaEvent.findOneAndDelete({
      _id: req.params.id,
      school: schoolId,
    });

    if (!agenda) {
      return res.status(404).json({ error: "Agenda not found" });
    }

    // ------------------------------------------------------------
    // 🔔 RESOLVE RECIPIENT USERS (ONCE)
    // ------------------------------------------------------------
    let recipientUsers = [];

    // CLASS → students + parents + teachers
    if (agenda.audience === "class" && agenda.class) {
      recipientUsers = await resolveRecipientUsersForClass(
        agenda.class,
        true
      );
    }

    // TEACHER → all teachers
    if (agenda.audience === "teacher") {
      const teachers = await User.find({
        role: "teacher",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = teachers.map(t => String(t._id));
    }

    // STUDENT → specific student
    if (agenda.audience === "student" && agenda.studentId) {
      const s = await Student.findById(agenda.studentId)
        .select("user parent parentIds")
        .lean();

      if (s?.user) recipientUsers.push(String(s.user));
      if (s?.parent) recipientUsers.push(String(s.parent));
      if (Array.isArray(s?.parentIds)) {
        s.parentIds.forEach(pid => pid && recipientUsers.push(String(pid)));
      }
    }

    // STUDENT → whole class
    if (agenda.audience === "student" && !agenda.studentId && agenda.class) {
      const students = await Student.find({
        class: agenda.class,
        school: schoolId,
      }).select("user").lean();

      recipientUsers.push(
        ...students.filter(s => s.user).map(s => String(s.user))
      );
    }

    // PARENT → all parents
    if (agenda.audience === "parent") {
      const parents = await User.find({
        role: "parent",
        school: schoolId,
      }).select("_id").lean();

      recipientUsers = parents.map(p => String(p._id));
    }

    // ALL → everyone in school
    if (agenda.audience === "all") {
      const users = await User.find({ school: schoolId })
        .select("_id")
        .lean();

      recipientUsers = users.map(u => String(u._id));
    }

    recipientUsers = [...new Set(recipientUsers)];

    // ------------------------------------------------------------
    // 🔔 CREATE IN-APP NOTIFICATION (FIXED)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await Notification.create({
        title: `Agenda Deleted: ${agenda.title}`,
        sender: req.user._id,
        school: schoolId,
        message: `Agenda deleted: ${agenda.title}`,
        type: "agenda",
        agendaId: agenda._id, // ✅ REQUIRED
        audience: agenda.audience,
        class: agenda.class || null,
        recipientRoles:
          agenda.audience === "all"
            ? ["teacher", "student", "parent"]
            : agenda.audience === "teacher"
            ? ["teacher"]
            : agenda.audience === "student"
            ? ["student"]
            : agenda.audience === "parent"
            ? ["parent"]
            : [],
        recipientUsers,
      });
    }

    // ------------------------------------------------------------
    // 📣 EXPO PUSH NOTIFICATION (SAME RECIPIENTS)
    // ------------------------------------------------------------
    if (recipientUsers.length > 0) {
      await sendPushToUsers(
        recipientUsers,
        "Agenda Deleted",
        `${agenda.title} has been removed`
      );
    }

    // ------------------------------------------------------------
    // 📤 RESPONSE
    // ------------------------------------------------------------
    res.json({ message: "Agenda deleted successfully" });

  } catch (err) {
    console.error("💥 deleteAgenda error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// --------------------------------------------------------------------
// 🎨 Get agenda dates (for calendar color coding)
// --------------------------------------------------------------------
exports.getAgendaDatesWithColors = async (req, res) => {
  try {
    const plainUser = req.user.toObject ? req.user.toObject() : req.user;
    const schoolId = await resolveSchoolForUser(plainUser);
    if (!schoolId) return res.status(403).json({ error: 'No school linked' });

    const agendas = await AgendaEvent.find({ school: schoolId });
    const coloredDates = agendas.map(a => {
      const d = new Date(a.date);
      return {
        _id: a._id,
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        audience: a.audience,
        color: a.color || getDefaultColor(a.audience),
        title: a.title,
      };
    });

    res.json(coloredDates);
  } catch (err) {
    console.error('💥 getAgendaDatesWithColors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// --------------------------------------------------------------------
// 👨‍🎓 Unified "My Agenda" (Student + Parent)
// --------------------------------------------------------------------
// --------------------------------------------------------------------
// 👨‍🎓 Unified "My Agenda" (Student + Parent) + Notification Binding
// --------------------------------------------------------------------
exports.getAgendasForStudent = async (req, res) => {
  try {
    const { from, to } = req.query;
    const studentId = req.query.studentId || req.body.studentId;
    const childId = req.query.childId || req.body.childId;
    const schoolId = req.user.school;

    let targetStudent;

    // ---------------------------------------------------------
    // 🔎 Identify actual student (student or parent request)
    // ---------------------------------------------------------
    if (req.user.role === 'student') {
      targetStudent = await Student.findOne({ user: req.user._id, school: schoolId })
        .populate('class school')
        .lean();
    } else if (req.user.role === 'parent') {
      const targetId = childId || studentId;
      if (!targetId) {
        return res.status(400).json({ message: 'Missing childId or studentId for parent request' });
      }

      targetStudent = await Student.findOne({
        _id: targetId,
        school: schoolId,
        $or: [
          { parent: req.user._id },
          { parentIds: { $in: [req.user._id] } }
        ]
      })
        .populate('class school')
        .lean();

      if (!targetStudent) {
        return res.status(403).json({
          message: 'Unauthorized: This child is not linked to your parent account.',
        });
      }
    }

    if (!targetStudent) {
      return res.status(404).json({ message: 'Student record not found' });
    }

    const effectiveSchoolId = targetStudent.school?._id || schoolId;

    // ---------------------------------------------------------
    // 🧠 Build effective user for filter
    // ---------------------------------------------------------
    const effectiveUser = {
      _id: req.user._id,
      role: req.user.role,
      school: effectiveSchoolId,
      class: targetStudent.class?._id,
      childClasses: targetStudent.class ? [targetStudent.class._id] : [],
    };

    // ---------------------------------------------------------
    // 🎯 Build agenda filter (student/parent rules)
    // ---------------------------------------------------------
    const filter = buildAgendaFilter(effectiveUser, from, to);

    // ---------------------------------------------------------
    // 📚 Fetch agendas
    // ---------------------------------------------------------
    const agendas = await AgendaEvent.find(filter)
      .populate("class", "name")
      .sort({ date: 1, time: 1 })
      .lean();

    const agendaIds = agendas.map(a => a._id);

    // ---------------------------------------------------------
    // 🔔 Fetch notifications for these agenda items
    // ---------------------------------------------------------
    const notifications = await Notification.find({
      school: effectiveSchoolId,
      type: "agenda",
      agendaId: { $in: agendaIds },
      $or: [
        { recipientUsers: req.user._id },
        { recipientRoles: req.user.role }
      ]
    })
      .select("agendaId isRead createdAt")
      .lean();

    // Build map for quick lookup
    const notifMap = {};
    notifications.forEach(n => {
      notifMap[String(n.agendaId)] = n;
    });

    // ---------------------------------------------------------
    // 🔔 Attach notification to each agenda item
    // ---------------------------------------------------------
    const finalAgendas = agendas.map(a => ({
      _id: a._id,
      title: a.title,
      description: a.description,
      date: a.date,
      time: a.time,
      audience: a.audience,
      color: a.color || getDefaultColor(a.audience),
      class: a.class ? { id: a.class._id, name: a.class.name } : null,
      notification: notifMap[String(a._id)] || null
    }));

    // ---------------------------------------------------------
    // 🔔 Auto-mark notifications as read
    // ---------------------------------------------------------
    await Notification.updateMany(
      {
        agendaId: { $in: agendaIds },
        recipientUsers: req.user._id,
        isRead: false
      },
      { $set: { isRead: true } }
    );

    // ---------------------------------------------------------
    // 📤 Send response
    // ---------------------------------------------------------
    return res.json({
      success: true,
      studentId: targetStudent._id,
      studentName: targetStudent.name,
      class: {
        id: targetStudent.class?._id,
        name: targetStudent.class?.name || "Unknown Class"
      },
      agendas: finalAgendas
    });

  } catch (err) {
    console.error("💥 getAgendasForStudent error:", err);
    return res.status(500).json({
      message: "Failed to fetch agenda",
      error: err.message
    });
  }
};


// --------------------------------------------------------------------
// 🧩 Core Agenda Fetch for Admin / Teacher
// --------------------------------------------------------------------
async function getAgendasCore(req, res, forcedRole = null) {
  try {
    const { from, to } = req.query;

    // Convert mongoose doc → plain object
    const safeUser = req.user?.toObject ? req.user.toObject() : req.user || {};

    // Apply forced role (admin/teacher endpoints)
    const user = forcedRole ? { ...safeUser, role: forcedRole } : safeUser;

    console.log("📥 Fetching agendas for role:", user.role);

    // -----------------------------------------------------------------
    // ⭐ FIX: Load teacher classes from the Teacher collection
    // -----------------------------------------------------------------
    if (user.role === "teacher") {
      let teacherClasses = [];

      // Load teacher document
      const TeacherModel = mongoose.model("Teacher");
      const teacherDoc = await TeacherModel.findOne({ user: user._id })
        .select("assignedClass assignedClasses")
        .lean();

      if (teacherDoc) {
        if (teacherDoc.assignedClass) {
          teacherClasses.push(teacherDoc.assignedClass);
        }

        if (Array.isArray(teacherDoc.assignedClasses)) {
          teacherClasses.push(...teacherDoc.assignedClasses);
        }
      }

      // Remove duplicates + ensure ObjectId format
      teacherClasses = teacherClasses
        .filter(Boolean)
        .map(id =>
          mongoose.Types.ObjectId.isValid(id)
            ? new mongoose.Types.ObjectId(id)
            : id
        );

      user.teachingClasses = teacherClasses;

      console.log("🟦 Final teacher class list:", teacherClasses);
    }

    // -----------------------------------------------------------------
    // Resolve school
    // -----------------------------------------------------------------
    let schoolId = await resolveSchoolForUser(user);
    if (!schoolId) {
      return res.status(403).json({ error: "No school linked" });
    }

    const effectiveUser = { ...user, school: schoolId };

    // -----------------------------------------------------------------
    // Build agenda filter
    // -----------------------------------------------------------------
    const filter = buildAgendaFilter(effectiveUser, from, to);

    console.log("🔎 Agenda filter:", JSON.stringify(filter, null, 2));

    // -----------------------------------------------------------------
    // Fetch agendas
    // -----------------------------------------------------------------
    const agendas = await AgendaEvent.find(filter)
      .populate("class", "name")
      .sort({ date: 1, time: 1 })
      .lean();

    return res.json({
      success: true,
      role: effectiveUser.role,
      agendas,
    });

  } catch (err) {
    console.error("💥 getAgendasCore error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// --------------------------------------------------------------------
// 🌍 Public wrappers for each role-based endpoint
// --------------------------------------------------------------------
exports.getAgendas = (req, res) => getAgendasCore(req, res);
exports.getAgendasForAdmin = (req, res) => getAgendasCore(req, res, 'admin');
exports.getAgendasForTeacher = (req, res) => getAgendasCore(req, res, 'teacher');
exports.getAgendasForParent = (req, res) => exports.getAgendasForStudent(req, res);

// --------------------------------------------------------------------
// 🎨 Default agenda colors
// --------------------------------------------------------------------
function getDefaultColor(audience) {
  return {
    student: '#2196F3',
    teacher: '#FF9800',
    parent: '#9C27B0',
    class: '#4CAF50',
    all: '#9E9E9E',
  }[audience] || '#E0F7FA';
}
