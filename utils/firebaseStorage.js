const admin = require("firebase-admin");

// Initialize Firebase Admin using environment variables
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  } catch (error) {
    console.error("Firebase Initialization Error (Likely missing env vars):", error.message);
  }
}

let bucket;
try {
  bucket = admin.storage().bucket();
} catch (error) {
  console.warn("Storage mock fallback because Firebase is not initialized");
  bucket = { file: () => ({ createWriteStream: () => ({ on: () => { }, end: () => { } }), makePublic: async () => { } }) };
}

/**
 * Uploads a file to Firebase Storage into a virtual folder.
 * @param {Object} file - The file object from multer
 * @param {String} folder - 'logo' or 'signature'
 * @param {String} schoolId - The school ID for naming
 * @returns {Promise<String>} public URL of the uploaded file
 */
async function uploadFile(file, folder = 'uploads', identifier = 'common') {
  return new Promise((resolve, reject) => {
    const filename = `${identifier}_${Date.now()}_${file.originalname}`;

    let filePath;
    if (folder === 'profiles') {
      filePath = `profiles/${identifier}/${filename}`;
    } else {
      filePath = `school-info/${folder}/${filename}`;
    }

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
