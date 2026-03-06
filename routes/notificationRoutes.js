const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  createNotification,
  getMyNotifications,
  markAsRead,
  markAllAsRead,
  markTypesAsRead
} = require('../controllers/notificationController');

// ========================================================
// 📌 YOUR EXISTING IN-APP NOTIFICATION ROUTES (unchanged)
// ========================================================
router.post('/', protect, createNotification);
router.get('/', protect, getMyNotifications);
router.patch('/mark-all-read', protect, markAllAsRead);
router.patch('/:id/read', protect, markAsRead);
router.post('/mark-read', protect, markTypesAsRead);

// ========================================================
// 📌 EXPO PUSH NOTIFICATION EXTENSIONS (NEW)
// ========================================================
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();


// ------------------------------
// 🔔 Register Expo push token
// ------------------------------
router.post("/register-token", protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const school = req.user.school;
    let { token, deviceInfo } = req.body;
    if (token) token = String(token).trim();

    console.log("📨 Incoming push token registration:", {
      token,
      userId,
      school,
      deviceInfo
    });

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    // Validate Expo token format
    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Expo push token",
      });
    }

    // --- ROBUST REGISTRATION LOGIC WITH DIAGNOSTICS ---
    console.log(`🔍 [DEBUG] [PUSH] Registering token: "${token}" for user: ${userId}`);
    console.log(`🔍 [DEBUG] [PUSH] Collection name: ${PushToken.collection.name}`);

    let record = await PushToken.findOne({ token });

    if (record) {
      console.log(`📖 [DEBUG] [PUSH] Found record: ${record._id}, current user: ${record.userId}`);
      // Reassign or update existing token
      record.userId = userId;
      record.school = school;
      record.deviceInfo = deviceInfo || record.deviceInfo;
      record.disabled = false;
      record.lastSeen = new Date();
      console.log(`💾 [DEBUG] [PUSH] Saving record: ${record._id}`);
      await record.save();
      console.log("✅ [DEBUG] [PUSH] Token reassigned/updated successfully");
    } else {
      // Create new token record
      const platform = (deviceInfo?.os || "").toLowerCase().includes("ios") ? "ios" : "android";

      try {
        record = await PushToken.create({
          userId,
          school,
          token,
          platform,
          deviceInfo: deviceInfo || {},
          disabled: false,
          lastSeen: new Date(),
        });
        console.log("✅ New push token created:", record._id);
      } catch (createErr) {
        // Handle race condition: token might have been created just now by another request
        if (createErr.code === 11000) {
          console.warn(`🚨 [DEBUG] [PUSH] E11000 during create. Falling back to findOneAndUpdate...`);
          console.warn(`🚨 [DEBUG] [PUSH] Err details: ${JSON.stringify(createErr.keyValue)}`);
          record = await PushToken.findOneAndUpdate(
            { token },
            {
              userId,
              school,
              deviceInfo,
              disabled: false,
              lastSeen: new Date(),
            },
            { new: true }
          );
          console.log(`✅ [DEBUG] [PUSH] Recovered from race condition via findOneAndUpdate. Record ID: ${record?._id}`);
        } else {
          console.error(`❌ [DEBUG] [PUSH] Fatal error during create:`, createErr);
          throw createErr;
        }
      }
    }

    console.log("✅ Push token saved:", record);

    res.json({
      success: true,
      message: "Push token registered",
      token: record.token,
    });

  } catch (error) {
    console.error("❌ Push token error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
});




// ------------------------------
// 🔔 Send push notification
// ------------------------------
router.post("/send-push", protect, async (req, res) => {
  try {
    const { userId, title, message, data } = req.body;

    if (!userId || !title || !message) {
      return res.status(400).json({
        success: false,
        message: "userId, title, and message are required",
      });
    }

    const tokens = await PushToken.find({ userId, disabled: false });

    if (!tokens.length) {
      return res.json({ success: true, message: "User has no valid push tokens" });
    }

    const messages = tokens
      .map((t) => t.token)
      .filter((token) => Expo.isExpoPushToken(token))
      .map((token) => ({
        to: token,
        sound: "default",
        title,
        body: message,
        data: data || {},
      }));

    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    res.json({ success: true, message: "Push sent", tickets });
  } catch (err) {
    console.error("Send push error:", err);
    res.status(500).json({ success: false, message: "Failed to send push" });
  }
});

module.exports = router;
