// removeDuplicates.js
require('dotenv').config();             // ← load .env
const mongoose = require('mongoose');
const StudentAttendance = require('./models/studentAttendance');

async function run() {
  const uri = process.env.MONGO_URI;
  if (typeof uri !== 'string') {
    console.error('❌ MONGO_URI not defined in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('🔗 Connected to MongoDB');

  // 1) Group duplicates by (student, date)
  const duplicates = await StudentAttendance.aggregate([
    {
      $group: {
        _id: { student: '$student', date: '$date' },
        count: { $sum: 1 },
        docs: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate records found.');
  } else {
    for (const group of duplicates) {
      // keep the first, delete the rest
      const [keep, ...remove] = group.docs;
      await StudentAttendance.deleteMany({ _id: { $in: remove } });
      console.log(`Kept ${keep}, removed ${remove.length} duplicates for student ${group._id.student} on ${group._id.date}`);
    }
  }

  await mongoose.disconnect();
  console.log('🔒 Disconnected and done.');
  process.exit(0);
}

run().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
