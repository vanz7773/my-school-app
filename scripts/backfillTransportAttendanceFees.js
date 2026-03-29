require('dotenv').config();
const mongoose = require('mongoose');

const TransportAttendance = require('../models/TransportAttendance');
const TransportEnrollment = require('../models/TransportEnrollment');

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const records = await TransportAttendance.find({}).lean();
  let updated = 0;
  let skipped = 0;

  for (const record of records) {
    const studentId = record.student?.toString?.() || String(record.student || '');
    if (!studentId) {
      skipped += 1;
      continue;
    }

    let dailyRate = Number(record.dailyRate || 0);
    let weeklyDaysExpected = Number(record.weeklyDaysExpected || 5) || 5;
    let expectedAmount = Number(record.expectedAmount || 0);

    if (!dailyRate) {
      const enrollment = await TransportEnrollment.findOne({
        student: record.student,
        school: record.school,
        status: 'active',
      }).select('feeAmount');

      dailyRate = Number(enrollment?.feeAmount) || Number(record.payment?.dailyRate || 0) || 0;
      expectedAmount = dailyRate;
    }

    if (!expectedAmount) {
      expectedAmount = dailyRate;
    }

    if (!dailyRate && !expectedAmount) {
      skipped += 1;
      continue;
    }

    await TransportAttendance.updateOne(
      { _id: record._id },
      {
        $set: {
          dailyRate,
          weeklyDaysExpected,
          expectedAmount,
        },
      }
    );

    updated += 1;
  }

  console.log(`✅ Updated ${updated} attendance record(s). Skipped: ${skipped}`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
