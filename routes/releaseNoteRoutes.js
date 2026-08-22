const express = require('express');
const router = express.Router();
const releaseNoteController = require('../controllers/releaseNoteController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/unseen', protect, releaseNoteController.getUnseenReleaseNotes);
router.post('/:id/seen', protect, releaseNoteController.markReleaseNoteSeen);

router.get('/', protect, restrictTo('admin', 'superadmin'), releaseNoteController.getReleaseNotes);
router.post('/', protect, restrictTo('admin', 'superadmin'), releaseNoteController.createReleaseNote);
router.put('/:id', protect, restrictTo('admin', 'superadmin'), releaseNoteController.updateReleaseNote);
router.delete('/:id', protect, restrictTo('admin', 'superadmin'), releaseNoteController.deleteReleaseNote);

module.exports = router;
