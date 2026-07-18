const express = require('express');
const router = express.Router();
const schoolLogbookController = require('../controllers/schoolLogbookController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/', protect, restrictTo('admin'), schoolLogbookController.getLogbookEntries);
router.post('/', protect, restrictTo('admin'), schoolLogbookController.createLogbookEntry);
router.put('/:id', protect, restrictTo('admin'), schoolLogbookController.updateLogbookEntry);
router.delete('/:id', protect, restrictTo('admin'), schoolLogbookController.deleteLogbookEntry);

module.exports = router;
