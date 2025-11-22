const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  createNotification,
  getMyNotifications,
  markAsRead,
  markTypesAsRead
} = require('../controllers/notificationController');

// 🔐 All routes are protected
router.post('/', protect, createNotification);             // Admin, teacher, parent can send
router.get('/', protect, getMyNotifications);              // All users receive
router.patch('/:id/read', protect, markAsRead);            // Mark as read
router.post('/mark-read', protect, markTypesAsRead);

module.exports = router;
