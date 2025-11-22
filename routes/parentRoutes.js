const express = require('express');
const router = express.Router();
const { protect, restrictTo } = require('../middlewares/authMiddleware');
const {
  createParent,
  getMyChildren,
  getAllParents,
  updateParent,
  deleteParent,
  linkChild,
  getChildrenByParentId, // ✅ new import
} = require('../controllers/parentController');

// Admin: Create parent
router.post('/', protect, restrictTo('admin'), createParent);

// Parent: Link a child by admission number
router.post('/link-child', protect, restrictTo('parent'), linkChild);

// Parent: View their own linked children
router.get('/children', protect, restrictTo('parent'), getMyChildren);

// Parent: View children by parentId (for dashboard use)
router.get('/:parentId/children', protect, restrictTo('parent'), getChildrenByParentId); // ✅ NEW

// Admin: View all parents
router.get('/', protect, restrictTo('admin'), getAllParents);

// Admin: Update parent
router.put('/:id', protect, restrictTo('admin'), updateParent);

// Admin: Delete parent
router.delete('/:id', protect, restrictTo('admin'), deleteParent);

module.exports = router;
