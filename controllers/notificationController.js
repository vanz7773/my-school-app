// controllers/notificationController.js
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Student = require('../models/Student');

/* ------------------------------------------------------------------
   PRE-COMPUTE MODEL CAPABILITIES (DO ONLY ONCE)
------------------------------------------------------------------ */
const MODEL_HAS = {
  recipientUsers: !!Notification.schema.paths.recipientUsers,
  recipientRoles: !!Notification.schema.paths.recipientRoles,
  recipient: !!Notification.schema.paths.recipient,
  audience: !!Notification.schema.paths.audience,
  class: !!Notification.schema.paths.class,
  read: !!Notification.schema.paths.read,
  readBy: !!Notification.schema.paths.readBy,
};

function resolveSchoolId(user) {
  return (
    user?.school?._id ||
    user?.school?.id ||
    (mongoose.Types.ObjectId.isValid(user?.school) ? user.school : null)
  );
}

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------ */

// Resolve user's class: prefer req.user.class, otherwise look up Student doc.
// Cache result in req._localCache to avoid repeated DB calls during one request.
async function resolveUserClass(req, userId) {
  req._localCache = req._localCache || {};
  if (req._localCache[`userClass:${userId}`] !== undefined) {
    return req._localCache[`userClass:${userId}`];
  }

  // prefer direct user.class
  if (req.user && req.user.class) {
    req._localCache[`userClass:${userId}`] = String(req.user.class);
    return req._localCache[`userClass:${userId}`];
  }

  // fallback: query Student collection
  try {
    const student = await Student.findOne({ user: userId }).select('class').lean();
    const cls = student?.class ? String(student.class) : null;
    req._localCache[`userClass:${userId}`] = cls;
    return cls;
  } catch (e) {
    // best-effort: cache null to avoid retries
    req._localCache[`userClass:${userId}`] = null;
    return null;
  }
}

/* ------------------------------------------------------------------
   UTILITY: Build payload based on model fields
   Accepts: audience, recipientIds (array), recipientRoles (array optional),
            classId (optional), type, title, message, relatedResource, resourceModel
------------------------------------------------------------------ */
function buildNotificationPayload(req, body) {
  const {
    title,
    message,
    type = 'general',
    audience = 'all',
    recipientIds = [],
    recipientRoles = null,
    classId = null,
    relatedResource = null,
    resourceModel = null,
  } = body;

  const payload = {
    title,
    message,
    type,
    sender: req.user?._id || null,
    school: resolveSchoolId(req.user),

    relatedResource: relatedResource || null,
    resourceModel: resourceModel || null,
  };

  if (MODEL_HAS.class) payload.class = classId || null;

  if (MODEL_HAS.recipientUsers) {
    // ensure array (mongoose will cast to ObjectId where required)
    payload.recipientUsers = Array.isArray(recipientIds) ? recipientIds : [];
  }

  if (MODEL_HAS.recipientRoles) {
    // allow explicit override, otherwise build from audience
    if (Array.isArray(recipientRoles) && recipientRoles.length > 0) {
      payload.recipientRoles = recipientRoles;
    } else {
      // audience === 'all' -> ['all'] else if audience is a role -> [audience]
      payload.recipientRoles = audience === 'all' ? ['all'] : (audience ? [audience] : []);
    }
  }

  if (MODEL_HAS.recipient) {
    payload.recipient = Array.isArray(recipientIds) && recipientIds.length === 1 ? recipientIds[0] : null;
  }

  if (MODEL_HAS.audience) payload.audience = audience || 'all';
  if (MODEL_HAS.read) payload.read = false;
  if (MODEL_HAS.readBy) payload.readBy = [];

  return payload;
}

/* ------------------------------------------------------------------
   REAL-TIME BROADCAST FILTER (class-aware)
   Returns true if the notification should be delivered to the given userObj
   userObj expected shape: { _id, role, school, class? }
------------------------------------------------------------------ */
function shouldDeliverNotificationToUser(notification, userObj) {
  // school mismatch -> never deliver
  if (String(notification.school) !== String(userObj.school)) return false;

  // class-level notifications: if notification.class exists, user must belong to that class
  if (notification.class) {
    // if userObj.class is missing, we conservatively don't deliver (unless the user is explicitly targeted)
    if (!userObj.class) {
      // allow if user is explicitly in recipientUsers
      if (notification.recipientUsers && notification.recipientUsers.map(String).includes(String(userObj._id))) {
        return true;
      }
      return false;
    }
    if (String(userObj.class) !== String(notification.class)) return false;
  }

  // explicit recipientUsers override everything
  if (notification.recipientUsers && notification.recipientUsers.map(String).includes(String(userObj._id))) return true;

  // audience equals role
  if (notification.audience && notification.audience !== 'all' && notification.audience === userObj.role) return true;

  // recipientRoles includes user's role
  if (notification.recipientRoles && notification.recipientRoles.includes(userObj.role)) return true;

  // audience = all OR recipientRoles includes 'all'
  if (notification.audience === 'all') return true;
  if (notification.recipientRoles && notification.recipientRoles.includes('all')) return true;

  return false;
}

/* ------------------------------------------------------------------
   SOCKET BROADCAST: deliver notification to connected users using preloaded caches
   - req.app.get('userCache') should be Map<userId, { role, school, class? }>
   - req.app.get('connectedUsers') should be Map<userId, socketId>
------------------------------------------------------------------ */
async function broadcastNotification(req, notification) {
  try {
    const io = req.app.get('io');
    if (!io) return;

    const userCache = req.app.get('userCache'); // Map(userId -> { role, school, class? })
    const connectedUsers = req.app.get('connectedUsers'); // Map(userId -> socketId)
    if (!userCache || !connectedUsers) return;

    // Avoid DB queries inside loop. If userCache lacks class for a user we skip class delivery
    for (const [uid, userObj] of userCache.entries()) {
      // only consider connected users
      const socketId = connectedUsers.get(uid);
      if (!socketId) continue;

      // Deliver only for same school quickly
      if (String(userObj.school) !== String(notification.school)) continue;

      // Build a shallow user object for checking
      const u = {
        _id: uid,
        role: userObj.role,
        school: userObj.school,
        class: userObj.class || null,
      };

      if (shouldDeliverNotificationToUser(notification, u)) {
        io.to(socketId).emit('notification', {
          _id: notification._id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          audience: notification.audience,
          class: notification.class || null,
          createdAt: notification.createdAt,
          sender: notification.sender ? { _id: notification.sender, name: notification.senderName || null } : null,
        });
      }
    }
  } catch (err) {
    console.warn('broadcastNotification error:', err);
  }
}

/* ------------------------------------------------------------------
   CREATE NOTIFICATION — CLASS-AWARE & SAFE
------------------------------------------------------------------ */
exports.createNotification = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ message: 'Title and message required' });

    const payload = buildNotificationPayload(req, req.body);
    const notification = await Notification.create(payload);

    // attach sender name for socket convenience (no DB join)
    const senderName = req.user?.name || null;
    notification.senderName = senderName;

    // Broadcast using cached maps (best-effort)
    await broadcastNotification(req, notification);

    return res.status(201).json({ message: 'Notification created', notification });
  } catch (err) {
    console.error('createNotification error:', err);
    return res.status(500).json({ message: 'Failed to create notification', error: err.message });
  }
};

/* ------------------------------------------------------------------
   GET MY NOTIFICATIONS — CLASS-AWARE
------------------------------------------------------------------ */
exports.getMyNotifications = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const schoolId = resolveSchoolId(req.user);

    if (!schoolId) {
      console.error("❌ schoolId unresolved in getMyNotifications", req.user.school);
      return res.status(400).json({ message: "School not resolved" });
    }

    const role = req.user.role;

    // resolve user's class (may query Student)
    const userClass = await resolveUserClass(req, userId);

    // Build OR clauses (only include model-backed fields)
    const or = [];
    if (MODEL_HAS.recipient) or.push({ recipient: userId });
    if (MODEL_HAS.recipientUsers) or.push({ recipientUsers: userId });
    if (MODEL_HAS.recipientRoles) or.push({ recipientRoles: role });
    if (MODEL_HAS.audience) or.push({ audience: role });
    or.push({ audience: 'all' });
    or.push({ recipientRoles: 'all' });

    // class filter: either global (class: null) or match user's class
    const classFilter = MODEL_HAS.class
      ? { $or: [{ class: null }, { class: userClass }] }
      : {};

    const query = MODEL_HAS.class
      ? { school: schoolId, $and: [{ $or: or }, classFilter] }
      : { school: schoolId, $or: or };

    const docs = await Notification.find(query)
      .sort({ createdAt: -1 })
      .populate('sender', 'name role')
      .lean();

    const formatted = docs.map((n) => ({
      ...n,
      isRead:
        (MODEL_HAS.readBy && n.readBy?.map(String).includes(userId)) ||
        (MODEL_HAS.read && n.read === true),
    }));

    return res.json(formatted);
  } catch (err) {
    console.error('getMyNotifications error:', err);
    return res.status(500).json({ message: 'Failed to get notifications', error: err.message });
  }
};

/* ------------------------------------------------------------------
   MARK AS READ
------------------------------------------------------------------ */
exports.markAsRead = async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user._id;

    const update = {};
    if (MODEL_HAS.readBy) update.$addToSet = { readBy: userId };
    if (MODEL_HAS.read) update.$set = { read: true };

    await Notification.updateOne({ _id: id }, update, { runValidators: false });
    return res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('markAsRead error:', err);
    return res.status(500).json({ message: 'Failed to mark read', error: err.message });
  }
};

/* ------------------------------------------------------------------
   MARK ALL AS READ — CLASS-AWARE
------------------------------------------------------------------ */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const role = req.user.role;
    const schoolId = resolveSchoolId(req.user);

    if (!schoolId) {
      return res.status(400).json({ message: "School not resolved" });
    }


    const userClass = await resolveUserClass(req, userId);

    const or = [];
    if (MODEL_HAS.recipient) or.push({ recipient: userId });
    if (MODEL_HAS.recipientUsers) or.push({ recipientUsers: userId });
    if (MODEL_HAS.recipientRoles) or.push({ recipientRoles: role });
    if (MODEL_HAS.audience) or.push({ audience: role });
    or.push({ audience: 'all' });
    or.push({ recipientRoles: 'all' });

    const update = {};
    if (MODEL_HAS.readBy) update.$addToSet = { readBy: userId };
    if (MODEL_HAS.read) update.$set = { read: true };

    const classFilter = MODEL_HAS.class ? { $or: [{ class: null }, { class: userClass }] } : {};

    const result = await Notification.updateMany(
      MODEL_HAS.class
        ? { school: schoolId, $and: [{ $or: or }, classFilter] }
        : { school: schoolId, $or: or },
      update
    );

    return res.json({ message: 'All marked read', modified: result.modifiedCount });
  } catch (err) {
    console.error('markAllAsRead error:', err);
    return res.status(500).json({ message: 'Failed to mark all read', error: err.message });
  }
};

/* ------------------------------------------------------------------
   DELETE NOTIFICATION
------------------------------------------------------------------ */
exports.deleteNotification = async (req, res) => {
  try {
    const id = req.params.id;
    const n = await Notification.findById(id);
    if (!n) return res.status(404).json({ message: 'Not found' });

    const user = req.user;
    const isSender = String(n.sender) === String(user._id);
    const schoolId = resolveSchoolId(user);
    const isAdmin =
      user.role === 'admin' && String(n.school) === String(schoolId);


    const isRecipient =
      (MODEL_HAS.recipient && String(n.recipient) === String(user._id)) ||
      (MODEL_HAS.recipientUsers && n.recipientUsers?.map(String).includes(String(user._id)));

    if (!(isSender || isAdmin || isRecipient)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    await n.deleteOne();
    return res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('deleteNotification error:', err);
    return res.status(500).json({ message: 'Failed to delete', error: err.message });
  }
};

/* ------------------------------------------------------------------
   CLEANUP OLD NOTIFICATIONS
------------------------------------------------------------------ */
exports.cleanupOldNotifications = async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const deleted = await Notification.deleteMany({ createdAt: { $lt: cutoff } });
    return res.json({ deleted: deleted.deletedCount });
  } catch (err) {
    console.error('cleanupOldNotifications error:', err);
    return res.status(500).json({ message: 'Failed', error: err.message });
  }
};

/* ------------------------------------------------------------------
   MARK TYPES AS READ — WITH CLASS FILTERING
------------------------------------------------------------------ */
exports.markTypesAsRead = async (req, res) => {
  try {
    const { types = [], class: classId = null } = req.body;
    const userId = String(req.user._id);
    const role = req.user.role;

    if (!Array.isArray(types) || types.length === 0) {
      return res.status(400).json({ message: "Missing types" });
    }

    const or = [
      { recipient: userId },
      { recipientUsers: userId },
      { recipientRoles: role },
      { audience: role },
      { audience: 'all' },
      { recipientRoles: 'all' },
    ];

    const schoolId = resolveSchoolId(req.user);

    if (!schoolId) {
      return res.status(400).json({ message: "School not resolved" });
    }

    const filter = {
      school: schoolId,
      type: { $in: types },
      $or: or,
    };


    if (classId) {
      // classId provided explicitly -> restrict to that class
      filter.class = classId;
    } else {
      // otherwise include notifications intended for user's class or global ones
      const userClass = await resolveUserClass(req, userId);
      if (MODEL_HAS.class) {
        filter.$and = [{ $or: [{ class: null }, { class: userClass }] }];
      }
    }

    const update = {};
    if (MODEL_HAS.readBy) update.$addToSet = { readBy: userId };
    if (MODEL_HAS.read) update.$set = { read: true };

    const result = await Notification.updateMany(filter, update);
    return res.json({ modified: result.modifiedCount });
  } catch (err) {
    console.error('markTypesAsRead error:', err);
    return res.status(500).json({ message: 'Failed', error: err.message });
  }
};
