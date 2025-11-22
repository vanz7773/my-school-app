const admin = require("firebase-admin");

// Initialize Firebase Admin using environment variables
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const bucket = admin.storage().bucket();

/**
 * Uploads a file to Firebase Storage into a virtual folder.
 * @param {Object} file - The file object from multer
 * @param {String} folder - 'logo' or 'signature'
 * @param {String} schoolId - The school ID for naming
 * @returns {Promise<String>} public URL of the uploaded file
 */
async function uploadFile(file, folder, schoolId) {
  return new Promise((resolve, reject) => {
    const filename = `${schoolId}_${Date.now()}_${file.originalname}`;
    const filePath = `school-info/${folder}/${filename}`;
    const fileUpload = bucket.file(filePath);

    const stream = fileUpload.createWriteStream({
      metadata: { contentType: file.mimetype },
    });

    stream.on("error", (err) => reject(err));

    stream.on("finish", async () => {
      // Make the file public (optional)
      await fileUpload.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      resolve(publicUrl);
    });

    stream.end(file.buffer);
  });
}

module.exports = { uploadFile };
