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
    const { token, deviceInfo } = req.body;

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

    const record = await PushToken.findOneAndUpdate(
      { userId, token },            // FIXED QUERY
      {
        userId,
        school,                     // ← CRITICAL FIX
        token,
        deviceInfo,
        disabled: false,
        lastSeen: new Date(),
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

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
