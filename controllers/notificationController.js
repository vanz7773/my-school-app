const { Expo } = require('expo-server-sdk');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Student = require('../models/Student');

// Initialize Expo SDK
const expo = new Expo();

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

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------ */

// Resolve user's class: prefer req.user.class, otherwise look up Student doc.
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
    req._localCache[`userClass:${userId}`] = null;
    return null;
  }
}

/* ------------------------------------------------------------------
   UTILITY: Build payload based on model fields
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
    school: req.user?.school || null,
    relatedResource: relatedResource || null,
    resourceModel: resourceModel || null,
  };

  if (MODEL_HAS.class) payload.class = classId || null;

  if (MODEL_HAS.recipientUsers) {
    payload.recipientUsers = Array.isArray(recipientIds) ? recipientIds : [];
  }

  if (MODEL_HAS.recipientRoles) {
    if (Array.isArray(recipientRoles) && recipientRoles.length > 0) {
      payload.recipientRoles = recipientRoles;
    } else {
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
   PUSH NOTIFICATION SERVICE
------------------------------------------------------------------ */
async function sendPushNotifications(userIds, title, message, data = {}) {
  try {
    if (!userIds || userIds.length === 0) return;

    // Fetch users with push tokens
    const users = await User.find({
      _id: { $in: userIds },
      pushToken: { $exists: true, $ne: null }
    }).select('pushToken');

    let messages = [];
    for (let user of users) {
      if (!Expo.isExpoPushToken(user.pushToken)) {
        console.error(`Push token ${user.pushToken} is not a valid Expo push token`);
        continue;
      }

      messages.push({
        to: user.pushToken,
        sound: 'default',
        title: title,
        body: message,
        data: data,
      });
    }

    let chunks = expo.chunkPushNotifications(messages);
    let tickets = [];

    for (let chunk of chunks) {
      try {
        let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error("Error sending push notification chunk:", error);
      }
    }
  } catch (error) {
    console.error("Error in sendPushNotifications:", error);
  }
}

/* ------------------------------------------------------------------
   REAL-TIME BROADCAST FILTER & PUSH TRIGGER
------------------------------------------------------------------ */
function shouldDeliverNotificationToUser(notification, userObj) {
  if (String(notification.school) !== String(userObj.school)) return false;

  if (notification.class) {
    if (!userObj.class) {
      if (notification.recipientUsers && notification.recipientUsers.map(String).includes(String(userObj._id))) {
        return true;
      }
      return false;
    }
    if (String(userObj.class) !== String(notification.class)) return false;
  }

  if (notification.recipientUsers && notification.recipientUsers.map(String).includes(String(userObj._id))) return true;
  if (notification.audience && notification.audience !== 'all' && notification.audience === userObj.role) return true;
  if (notification.recipientRoles && notification.recipientRoles.includes(userObj.role)) return true;
  if (notification.audience === 'all') return true;
  if (notification.recipientRoles && notification.recipientRoles.includes('all')) return true;

  return false;
}

async function broadcastNotification(req, notification) {
  try {
    const io = req.app.get('io');
    const userCache = req.app.get('userCache');
    const connectedUsers = req.app.get('connectedUsers');

    const recipientsForPush = [];

    if (io && userCache) {
      for (const [uid, userObj] of userCache.entries()) {
        const u = {
          _id: uid,
          role: userObj.role,
          school: userObj.school,
          class: userObj.class || null,
        };

        if (shouldDeliverNotificationToUser(notification, u)) {
          // Socket delivery
          if (connectedUsers && connectedUsers.has(uid)) {
            const socketId = connectedUsers.get(uid);
            io.to(socketId).emit('notification', {
              _id: notification._id,
              title: notification.title,
              message: notification.message,
              type: notification.type,
              createdAt: notification.createdAt,
              sender: notification.sender ? { _id: notification.sender, name: notification.senderName || null } : null,
            });
          } else {
            // Determine offline users for Push Notification
            recipientsForPush.push(uid);
          }
        }
      }
    }

    // Also consider explicitly targeted recipientUsers even if not in cache (fresh startup scenario)
    if (notification.recipientUsers && notification.recipientUsers.length > 0) {
      const explicitIds = notification.recipientUsers.map(String);
      recipientsForPush.push(...explicitIds);
    }

    // Deduplicate push recipients
    const uniquePushRecipients = [...new Set(recipientsForPush)];

    if (uniquePushRecipients.length > 0) {
      // Send Push Notifications Background Task
      sendPushNotifications(uniquePushRecipients, notification.title, notification.message, { notificationId: notification._id });
    }

  } catch (err) {
    console.warn('broadcastNotification error:', err);
  }
}

// Helper to manually trigger push from other controllers
exports.sendPushToUser = async (userId, title, message, data = {}) => {
  await sendPushNotifications([userId], title, message, data);
};


/* ------------------------------------------------------------------
   CREATE NOTIFICATION
------------------------------------------------------------------ */
exports.createNotification = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ message: 'Title and message required' });

    const payload = buildNotificationPayload(req, req.body);
    const notification = await Notification.create(payload);

    const senderName = req.user?.name || null;
    notification.senderName = senderName;

    await broadcastNotification(req, notification);

    return res.status(201).json({ message: 'Notification created', notification });
  } catch (err) {
    console.error('createNotification error:', err);
    return res.status(500).json({ message: 'Failed to create notification', error: err.message });
  }
};

/* ------------------------------------------------------------------
   GET MY NOTIFICATIONS
------------------------------------------------------------------ */
exports.getMyNotifications = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const schoolId = String(req.user.school);
    const role = req.user.role;

    const userClass = await resolveUserClass(req, userId);

    const or = [];
    if (MODEL_HAS.recipient) or.push({ recipient: userId });
    if (MODEL_HAS.recipientUsers) or.push({ recipientUsers: userId });
    if (MODEL_HAS.recipientRoles) or.push({ recipientRoles: role });
    if (MODEL_HAS.audience) or.push({ audience: role });
    or.push({ audience: 'all' });
    or.push({ recipientRoles: 'all' });

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
   MARK ALL AS READ
------------------------------------------------------------------ */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const role = req.user.role;
    const schoolId = String(req.user.school);

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
    const isAdmin = user.role === 'admin' && String(n.school) === String(user.school);

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
   MARK TYPES AS READ
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

    const filter = {
      school: req.user.school,
      type: { $in: types },
      $or: or,
    };

    if (classId) {
      filter.class = classId;
    } else {
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
