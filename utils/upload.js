// utils/upload.js
const multer = require("multer");

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/png", "image/jpg"];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG/PNG files are allowed"), false);
  }
};

// multer middleware already configured for logo + signature
const upload = multer({ storage, fileFilter }).fields([
  { name: "logo", maxCount: 1 },
  { name: "signature", maxCount: 1 },
]);

module.exports = upload;
