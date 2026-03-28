const mongoose = require('mongoose');
require('dotenv').config();

// Assuming models are available in the current context (I will need to verify the path)
const TransportEnrollment = require('./models/TransportEnrollment');
const Student = require('./models/Student');

async function migrateEnrollments() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/my-school-app'; // Adjust as needed
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const enrollments = await TransportEnrollment.find().sort({ updatedAt: -1 });
    const seen = new Set();
    const toDelete = [];

    for (const enrollment of enrollments) {
      const key = `${enrollment.student}_${enrollment.school}`;
      if (seen.has(key)) {
        toDelete.push(enrollment._id);
      } else {
        seen.add(key);
      }
    }

    if (toDelete.length > 0) {
      console.log(`Deleting ${toDelete.length} duplicate enrollments...`);
      await TransportEnrollment.deleteMany({ _id: { $in: toDelete } });
    } else {
      console.log('No duplicate enrollments found.');
    }

    console.log('Migration complete!');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrateEnrollments();
