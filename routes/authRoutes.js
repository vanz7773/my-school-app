const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware'); // ✅ unified middleware imports
const { checkPermission } = require('../middlewares/permissionMiddleware');

// ===============================
// AUTH & PASSWORD MANAGEMENT ROUTES
// ===============================

// ✅ Register a user (admin creates teacher, student, or parent)
router.post('/register', authController.register);

// ✅ Login a user
router.post('/login', authController.login);

// ✅ Logout a user
router.post('/logout', authController.logout);

// ✅ ADMIN: Issue password reset token/link for a user (admin panel use)
router.post(
  '/admin/issue-reset',
  protect,
  checkPermission('canManageAdmins'),
  authController.issueResetToken
);

// ✅ Admin management: create restricted admin accounts for the same school
router.get(
  '/admins',
  protect,
  checkPermission('canManageAdmins'),
  authController.listAdmins
);

router.post(
  '/admins',
  protect,
  checkPermission('canManageAdmins'),
  authController.createAdmin
);

router.put(
  '/admins/:id',
  protect,
  checkPermission('canManageAdmins'),
  authController.updateAdmin
);

router.delete(
  '/admins/:id',
  protect,
  checkPermission('canManageAdmins'),
  authController.deleteAdmin
);

// ✅ USER: Reset password using admin-issued token (via link)
router.post('/reset-password', authController.resetPassword);

// ✅ SELF-SERVICE (Students only): Request password reset using Email + Date of Birth
router.post('/request-reset-dob', authController.requestResetWithDOB);

// ✅ SELF-SERVICE: Complete password reset using the 6-digit verification code
router.post('/reset-password-dob', authController.resetPasswordWithCode);

// ✅ ADMIN SELF-SERVICE: Request password reset (no DOB)
router.post('/admin/request-reset', authController.requestResetForAdmin);

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
  checkPermission('canManageAdmins'),
  authController.listAdminResetRequests
);

// ✅ Admin: Approve a reset request (generate temporary password)
router.put(
  '/admin/reset-requests/:id/approve',
  protect,
  checkPermission('canManageAdmins'),
  authController.approveAdminResetRequest
);

// ✅ Admin: Reject a reset request
router.put(
  '/admin/reset-requests/:id/reject',
  protect,
  checkPermission('canManageAdmins'),
  authController.rejectAdminResetRequest
);

module.exports = router;
