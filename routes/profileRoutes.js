const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middlewares/authMiddleware');
const profileController = require('../controllers/profileController');

// Configure multer in-memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// 🟢 Get current profile
router.get('/', protect, profileController.getProfile);

// 🟢 Mark welcome as seen
router.post('/welcome-seen', protect, profileController.markWelcomeSeen);

// 🟢 Upload/update profile picture
router.post('/picture', protect, upload.single('profilePicture'), profileController.updateProfilePicture);

module.exports = router;
