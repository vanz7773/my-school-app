const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, requireAdmin, isAdmin } = require('../middlewares/authMiddleware'); // ✅ unified middleware imports

// ===============================
// AUTH & PASSWORD MANAGEMENT ROUTES
// ===============================

// ✅ Register a user (admin creates teacher, student, or parent)
router.post('/register', authController.register);

// ✅ Login a user
router.post('/login', authController.login);

// ✅ ADMIN: Issue password reset token/link for a user (admin panel use)
router.post(
  '/admin/issue-reset',
  protect,
  requireAdmin,
  authController.issueResetToken
);

// ✅ USER: Reset password using admin-issued token (via link)
router.post('/reset-password', authController.resetPassword);

// ✅ SELF-SERVICE (Students only): Request password reset using Email + Date of Birth
router.post('/request-reset-dob', authController.requestResetWithDOB);

// ✅ SELF-SERVICE: Complete password reset using the 6-digit verification code
router.post('/reset-password-dob', authController.resetPasswordWithCode);

// ✅ ADMIN-ASSIGNED RESET (Teachers/Parents): Request password reset → logged for admin approval
// 🔹 NOTE: The "/auth" prefix was removed to prevent double prefixing (/api/auth/auth/...)
router.post('/request-reset-admin', authController.requestAdminResetSelfService);

// ✅ AUTHENTICATED USER: Change password directly (used in profile modal)
router.post('/change-password', protect, authController.changePassword);

// ===============================
// ADMIN-ONLY: REVIEW / HANDLE RESET REQUESTS
// ===============================

// ✅ Admin: View all password reset requests (pending/approved/rejected)
router.get(
  '/admin/reset-requests',
  protect,
  isAdmin,
  authController.listAdminResetRequests
);

// ✅ Admin: Approve a reset request (generate temporary password)
router.put(
  '/admin/reset-requests/:id/approve',
  protect,
  isAdmin,
  authController.approveAdminResetRequest
);

// ✅ Admin: Reject a reset request
router.put(
  '/admin/reset-requests/:id/reject',
  protect,
  isAdmin,
  authController.rejectAdminResetRequest
);

module.exports = router;
