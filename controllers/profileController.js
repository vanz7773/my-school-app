// controllers/profileController.js
const User = require("../models/User");
const { uploadFile } = require("../utils/firebaseStorage");
const admin = require("firebase-admin");

// ---------------- CACHE CONFIGURATION ----------------
const profileCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------------- HELPERS ----------------
/**
 * Safely extract file path from Firebase Storage URL with multiple fallback methods
 */
function extractFilePath(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    // Method 1: Standard Firebase Storage URL format
    if (url.includes('/o/')) {
      const match = url.match(/\/o\/([^?]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }

    // Method 2: Google APIs URL format
    if (url.includes('googleapis.com')) {
      const urlObj = new URL(url);
      const path = urlObj.pathname.split('/').pop();
      if (path) return decodeURIComponent(path);
    }

    // Method 3: Direct path (already encoded)
    const directPath = url.split('/').pop()?.split('?')[0];
    return directPath ? decodeURIComponent(directPath) : null;
  } catch (error) {
    console.warn('⚠️ URL parsing error:', error.message);
    return null;
  }
}

/**
 * Safely delete file from Firebase Storage with retry mechanism
 */
async function deleteFileFromFirebase(url, retries = 2) {
  if (!url) return;

  const filePath = extractFilePath(url);
  if (!filePath) {
    console.warn('⚠️ Could not extract file path from URL:', url);
    return;
  }

  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);

  try {
    // Check if file exists before attempting deletion
    const [exists] = await file.exists();
    if (!exists) {
      console.log('ℹ️ File already deleted:', filePath);
      return;
    }

    await file.delete();
    console.log("🗑️ Successfully deleted profile picture:", filePath);

    // Invalidate cache for any user with this profile picture
    profileCache.forEach((value, key) => {
      if (value.profilePicture === url) {
        profileCache.delete(key);
      }
    });
  } catch (error) {
    if (retries > 0 && error.code === 429) {
      // Rate limited - retry with exponential backoff
      const delay = Math.pow(2, 3 - retries) * 1000;
      console.warn(`⚠️ Rate limited, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return deleteFileFromFirebase(url, retries - 1);
    }

    // Don't throw for deletion errors - log and continue
    console.warn("⚠️ Could not delete old profile picture:", error.message);
  }
}

/**
 * Cache management helper
 */
function getCachedProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  profileCache.delete(userId);
  return null;
}

function setCachedProfile(userId, data) {
  profileCache.set(userId, {
    data,
    timestamp: Date.now()
  });
}

function invalidateProfileCache(userId) {
  profileCache.delete(userId);
}

// ---------------- CONTROLLERS ----------------

/**
 * Get current profile with caching
 * GET /api/profile
 */
exports.getProfile = async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.id;

  try {
    // Check cache first
    const cachedProfile = getCachedProfile(userId);
    if (cachedProfile) {
      console.log(`⚡ Profile cache hit for user ${userId}`);
      return res.json(cachedProfile);
    }

    // Cache miss - fetch from database
    const user = await User.findById(userId)
      .select("name email profilePicture role school")
      .populate("school", "name schoolType features")
      .lean()
      .exec();



    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Set cache
    setCachedProfile(userId, user);

    console.log(`✅ Profile fetched in ${Date.now() - startTime}ms`);
    res.json(user);

  } catch (err) {
    console.error("❌ Error fetching profile:", err);

    // Determine appropriate status code
    const statusCode = err.name === 'CastError' ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      message: "Error fetching profile",
      error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
};

/**
 * Update profile picture with transaction-like safety
 * PUT /api/profile/picture
 */
exports.updateProfilePicture = async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.id;
  const file = req.file;

  // Validate file presence and type
  if (!file) {
    return res.status(400).json({
      success: false,
      message: "No file uploaded"
    });
  }

  // Validate file type
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return res.status(400).json({
      success: false,
      message: "Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed."
    });
  }

  // Validate file size (max 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    return res.status(400).json({
      success: false,
      message: "File too large. Maximum size is 5MB."
    });
  }

  let newFileUrl = null;
  let oldProfilePicture = null;

  try {
    // Fetch user first to get current profile picture
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    oldProfilePicture = user.profilePicture;

    // Upload new file to Firebase
    newFileUrl = await uploadFile(file);

    if (!newFileUrl) {
      throw new Error('File upload failed - no URL returned');
    }

    // Update user profile picture
    user.profilePicture = newFileUrl;
    await user.save();

    // Invalidate cache
    invalidateProfileCache(userId);

    // Delete old picture in background (non-blocking)
    if (oldProfilePicture) {
      process.nextTick(() => {
        deleteFileFromFirebase(oldProfilePicture)
          .catch(error => {
            console.error('Background deletion failed:', error);
          });
      });
    }

    console.log(`✅ Profile picture updated in ${Date.now() - startTime}ms`);

    res.json({
      success: true,
      message: "Profile picture updated successfully",
      profilePicture: newFileUrl
    });

  } catch (err) {
    console.error("❌ Error updating profile picture:", err);

    // Cleanup: Delete the new file if upload was successful but something else failed
    if (newFileUrl) {
      process.nextTick(() => {
        deleteFileFromFirebase(newFileUrl)
          .catch(cleanupError => {
            console.error('Cleanup deletion failed:', cleanupError);
          });
      });
    }

    // Determine appropriate status code
    let statusCode = 500;
    let errorMessage = "Error updating profile picture";

    if (err.message.includes('upload failed')) {
      statusCode = 502;
      errorMessage = "Storage service unavailable";
    } else if (err.message.includes('permission')) {
      statusCode = 403;
      errorMessage = "Insufficient permissions";
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
};

/**
 * Delete profile picture
 * DELETE /api/profile/picture
 */
exports.deleteProfilePicture = async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const oldProfilePicture = user.profilePicture;

    if (!oldProfilePicture) {
      return res.status(400).json({
        success: false,
        message: "No profile picture to delete"
      });
    }

    // Remove profile picture from user
    user.profilePicture = null;
    await user.save();

    // Invalidate cache
    invalidateProfileCache(userId);

    // Delete file from storage in background
    process.nextTick(() => {
      deleteFileFromFirebase(oldProfilePicture)
        .catch(error => {
          console.error('Background deletion failed:', error);
        });
    });

    res.json({
      success: true,
      message: "Profile picture deleted successfully"
    });

  } catch (err) {
    console.error("❌ Error deleting profile picture:", err);

    res.status(500).json({
      success: false,
      message: "Error deleting profile picture",
      error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
};

/**
 * Update user profile (name, email, etc.)
 * PUT /api/profile
 */
exports.updateProfile = async (req, res) => {
  const userId = req.user.id;
  const { name, email } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Update allowed fields
    const updates = {};
    if (name && name !== user.name) updates.name = name;
    if (email && email !== user.email) {
      // Check if email is already in use by another user
      const existingUser = await User.findOne({ email, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "Email already in use"
        });
      }
      updates.email = email;
    }

    // If no valid updates
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid changes provided"
      });
    }

    // Apply updates
    Object.assign(user, updates);
    await user.save();

    // Invalidate cache
    invalidateProfileCache(userId);

    res.json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profilePicture: user.profilePicture
      }
    });

  } catch (err) {
    console.error("❌ Error updating profile:", err);

    const statusCode = err.name === 'ValidationError' ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      message: "Error updating profile",
      error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
};

// ---------------- CACHE CLEANUP (optional) ----------------
// Clean expired cache entries every hour
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  profileCache.forEach((value, key) => {
    if (now - value.timestamp > CACHE_TTL) {
      profileCache.delete(key);
      cleanedCount++;
    }
  });

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} expired cache entries`);
  }
}, 60 * 60 * 1000); // 1 hour