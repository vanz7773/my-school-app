const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const { 
  createAnnouncement, 
  getMyAnnouncements, 
  sendNotificationByStudentOrParent,
  getAnnouncementsForSchool,
  getAnnouncementById,
  updateAnnouncement,        // new
  softDeleteAnnouncement     // new
} = require('../controllers/announcementController');

// Admin or Teacher can create announcements
router.post(
  '/',
  protect,
  restrictTo('admin', 'teacher'),
  createAnnouncement
);

// Admin/Teacher: list announcements for the school (optional filters supported in controller)
router.get(
  '/',
  protect,
  restrictTo('admin', 'teacher'),
  getAnnouncementsForSchool
);

// Any authenticated user gets their announcements
router.get('/my', protect, getMyAnnouncements);

// Students or Parents can send notifications -> now creates announcement targeted to teachers/admins
router.post(
  '/notify',
  protect,
  restrictTo('student', 'parent'),
  sendNotificationByStudentOrParent
);

// PATCH: update announcement (admin or owning teacher)
router.patch(
  '/:id',
  protect,
  restrictTo('admin', 'teacher'),
  updateAnnouncement
);

// DELETE: soft-delete announcement (admin or owning teacher)
router.delete(
  '/:id',
  protect,
  restrictTo('admin', 'teacher'),
  softDeleteAnnouncement
);

// Fetch a single announcement by id (kept last so '/my' and '/notify' are not swallowed)
router.get('/:id', protect, getAnnouncementById);

module.exports = router;
