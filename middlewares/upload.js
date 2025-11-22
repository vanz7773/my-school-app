// middlewares/upload.js  (memory storage version)
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

const upload = multer({ storage, fileFilter });

module.exports = upload; // export the multer instance
