const express = require('express');
const router = express.Router();
const upload = require('../utils/upload'); // the memory-storage version
const { saveSchoolInfo, getSchoolInfo, getFileById } = require('../controllers/schoolInfocontroller');
const { protect } = require('../middlewares/authMiddleware');

router.get('/', protect, getSchoolInfo);

router.post(
  '/',
  protect,
  upload,  // use directly, do NOT call .fields() here
  saveSchoolInfo
);

router.get('/files/:id', protect, getFileById);

module.exports = router;
