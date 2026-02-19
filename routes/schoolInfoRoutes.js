const express = require('express');
const router = express.Router();

const { saveSchoolInfo, getSchoolInfo, updateSchoolLocation, proxyImage } = require('../controllers/schoolInfoController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

// IMPORTANT: require the multer instance (memory storage) here.
// Adjust path if your file is at ../utils/upload instead of ../middlewares/upload
const upload = require('../middlewares/upload'); // <-- should export multer instance (not upload.fields result)

// Create the fields middleware from the multer instance
const uploadFieldsMiddleware = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'signature', maxCount: 1 },
]);

// Small wrapper to catch Multer errors and send nice responses instead of crashing
function multerWrapper(req, res, next) {
  uploadFieldsMiddleware(req, res, function (err) {
    if (err) {
      console.error('Multer error:', err);
      // Multer file size or file type validation errors commonly show up here.
      // Customize messages if you want; keep 400 for client errors.
      return res.status(400).json({
        message: 'File upload error',
        error: err.message || 'Invalid file upload'
      });
    }
    next();
  });
}

// Proxy image route (public to simplify fetching)
router.get('/proxy-image', proxyImage);

// GET school info
router.get('/', protect, getSchoolInfo);

// POST school info — multer handles logo + signature (multipart/form-data)
router.post('/', protect, multerWrapper, saveSchoolInfo);

// Admin route to update geofence
router.put('/:id/location', protect, restrictTo('admin'), updateSchoolLocation);

module.exports = router;
