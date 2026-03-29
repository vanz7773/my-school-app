require('dotenv').config();
const mongoose = require('mongoose');

const TransportAttendance = require('../models/TransportAttendance');
const TransportEnrollment = require('../models/TransportEnrollment');
const LegacyPayment = require('../models/transportWeeklyFeePayment');

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const payments = await LegacyPayment.find({}).lean();
  let migrated = 0;
  let skipped = 0;

  for (const legacy of payments) {
    const studentId = legacy.student?.toString?.() || String(legacy.student || '');
    if (!studentId || !legacy.date) {
      skipped += 1;
      continue;
    }

    const enrollment = await TransportEnrollment.findOne({
      student: legacy.student,
      school: legacy.school,
      status: 'active',
    }).populate('route', 'name');

    const routeSnapshot = enrollment?.route?.name || 'Unknown Route';
    const stopSnapshot = enrollment?.stop || 'Unknown Stop';
    const daysCount = Number(legacy.daysCount || 0);
    const dailyRate = Number(legacy.dailyRate || 0);
    const totalAmount = Number(legacy.totalAmount || 0);

    await TransportAttendance.findOneAndUpdate(
      { student: legacy.student, date: legacy.date },
      {
        $setOnInsert: {
          student: legacy.student,
          date: legacy.date,
          routeSnapshot,
          stopSnapshot,
          picked: false,
          isAbsent: false,
          dropped: false,
          markedBy: legacy.recordedBy || legacy.student,
          school: legacy.school,
        },
        $set: {
          term: legacy.term,
          academicYear: legacy.academicYear,
          routeSnapshot,
          stopSnapshot,
          payment: {
            weekLabel: legacy.weekLabel || '',
            daysCount,
            dailyRate,
            totalAmount,
            paymentMethod: legacy.paymentMethod || 'Cash',
            notes: legacy.notes || '',
            recordedBy: legacy.recordedBy || null,
            paidAt: legacy.createdAt || new Date(),
          },
          school: legacy.school,
        },
      },
      { upsert: true, new: true }
    );

    if (process.env.DELETE_LEGACY_TRANSPORT_PAYMENTS === 'true') {
      await LegacyPayment.deleteOne({ _id: legacy._id });
    }

    migrated += 1;
  }

  console.log(`✅ Migrated ${migrated} transport payment record(s). Skipped: ${skipped}`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
