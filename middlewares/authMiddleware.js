const jwt = require('jsonwebtoken');
const User = require('../models/User');
const FeedingFeeConfig = require('../models/FeedingFeeConfig');

// ============================
// 🔐 TOKEN EXTRACTION HELPER
// ============================
const getTokenFromRequest = (req) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    return req.headers.authorization.split(' ')[1];
  }

  // Optionally support token from cookies
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  return null;
};

// ============================
// 🔒 AUTH PROTECTION
// ============================
const protect = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    console.warn('❌ No token provided');
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      console.warn('❌ User not found for decoded token:', decoded);
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.school) {
      console.warn('❌ User has no school assigned');
      return res.status(403).json({ message: 'No school linked to user account' });
    }

    req.user = user;

    console.log('✅ Authenticated User:', {
      id: user._id.toString(),
      role: user.role,
      school: user.school?.toString(),
    });

    next();
  } catch (err) {
    console.error('❌ Token error:', err.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

// ============================
// 🛑 ROLE-BASED ACCESS CONTROL
// ============================

// Allow only specific roles
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      console.warn('❌ Access denied: Role mismatch', {
        required: roles,
        actual: req.user.role,
      });
      return res.status(403).json({ message: 'Access denied: insufficient permissions' });
    }
    console.log('✅ Access granted for role:', req.user.role);
    next();
  };
};

// Shortcut for admin-only access
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    console.warn('❌ Access denied: Admins only');
    return res.status(403).json({ message: 'Access denied: Admins only' });
  }
  console.log('✅ Admin access granted');
  next();
};

// NEW ✅ For admin-only routes in password reset flow (alias for consistency)
const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    console.warn('❌ Access denied: Admin privileges required');
    return res.status(403).json({ message: 'Admins only' });
  }
  console.log('✅ Verified admin access');
  next();
};

// ============================
// 🏫 SCHOOL VALIDATION HELPERS
// ============================

// Require school to be linked to user
const requireSchool = (req, res, next) => {
  if (!req.user?.school) {
    console.warn('❌ No school assigned to user');
    return res.status(403).json({ message: 'No school assigned to user' });
  }
  next();
};

// Verify ownership of a resource (e.g., belongs to same school)
const verifySchoolOwnership = (Model, idParam = 'id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[idParam] || req.body[idParam];

      if (!resourceId) {
        console.warn('❌ No resource ID provided');
        return res.status(400).json({ message: 'Missing resource ID' });
      }

      const resource = await Model.findById(resourceId);
      if (!resource) {
        console.warn('❌ Resource not found:', resourceId);
        return res.status(404).json({ message: 'Resource not found' });
      }

      if (resource.school?.toString() !== req.user.school.toString()) {
        console.warn('❌ Access denied: School mismatch');
        return res.status(403).json({ message: 'Access denied: resource not in your school' });
      }

      req.resource = resource;
      next();
    } catch (err) {
      console.error('❌ Error verifying resource ownership:', err);
      res.status(500).json({ message: 'Server error verifying ownership' });
    }
  };
};

// ============================
// ⚙️ INITIALIZATION HELPERS
// ============================

// Create default school configuration (e.g., Feeding Fee)
const initializeSchoolConfig = async (schoolId) => {
  try {
    await FeedingFeeConfig.create({
      school: schoolId,
      // Model schema defaults will populate other values
    });
    console.log(`✅ Initialized FeedingFeeConfig for school ${schoolId}`);
  } catch (error) {
    console.error('❌ Error initializing school config:', error);
  }
};

// ============================
// 📦 EXPORTS
// ============================
module.exports = {
  protect,
  restrictTo,
  requireAdmin,
  isAdmin, // ✅ added for new admin reset approval routes
  requireSchool,
  verifySchoolOwnership,
  initializeSchoolConfig,
};
