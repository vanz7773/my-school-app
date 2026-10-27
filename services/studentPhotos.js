const Jimp = require('jimp');
const { randomUUID } = require('crypto');
const { uploadFile } = require('../utils/firebaseStorage');

// Keep the full picture for reports/previews and a small copy for mobile lists.
const uploadStudentPhoto = async (file, schoolId) => {
  const profilePicture = await uploadFile(file, 'profiles', schoolId);
  let profilePictureThumbnail = '';
  try {
    const image = await Jimp.read(file.buffer);
    const buffer = await image.cover(160, 160).quality(75).getBufferAsync(Jimp.MIME_JPEG);
    profilePictureThumbnail = await uploadFile({
      buffer, mimetype: Jimp.MIME_JPEG, originalname: `thumbnail-${randomUUID()}.jpg`,
    }, 'profiles', schoolId);
  } catch (error) {
    // The original remains usable if thumbnail processing/storage fails.
    console.warn('Student photo thumbnail unavailable:', error.message);
  }
  return { profilePicture, profilePictureThumbnail };
};

module.exports = { uploadStudentPhoto };
