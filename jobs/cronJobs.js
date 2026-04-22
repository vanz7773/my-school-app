const cron = require('node-cron');
const mongoose = require('mongoose');
const Teacher = require('../models/Teacher');
const Term = require('../models/term');
const Attendance = require('../models/TeacherAttendance');
const PushToken = require('../models/PushToken');
const { sendPushNotifications } = require('../controllers/notificationController');

/**
 * Helper to fetch push tokens for teachers who should receive notifications today.
 * Excludes teachers if their school is not in an active term or if today is a Holiday.
 */
async function getEligibleTeacherTokens() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  try {
    // 1. Find schools in an active term
    const activeTerms = await Term.find({
      startDate: { $lte: todayEnd },
      endDate: { $gte: todayStart }
    }).select('school').lean();
    const activeSchools = [...new Set(activeTerms.map(t => String(t.school)))];

    // 2. Find schools that are marked as Holiday today
    const holidayAttendances = await Attendance.find({
      status: 'Holiday',
      date: { $gte: todayStart, $lte: todayEnd }
    }).select('school').lean();
    const schoolsOnHoliday = [...new Set(holidayAttendances.map(a => String(a.school)))];

    // 3. Find all teachers
    const teachers = await Teacher.find().lean();

    const eligibleUserIds = [];
    for (const t of teachers) {
      const schoolStr = String(t.school);
      
      // Skip if school is not currently in an active term
      if (!activeSchools.includes(schoolStr)) continue;
      
      // Skip if school is marked as a Holiday today
      if (schoolsOnHoliday.includes(schoolStr)) continue;

      if (t.user) {
        eligibleUserIds.push(t.user);
      }
    }

    // 4. Look up their push tokens
    const pushTokenDocs = await PushToken.find({ userId: { $in: eligibleUserIds } }).lean();
    const validTokens = pushTokenDocs
      .filter(doc => doc.token)
      .map(doc => doc.token);

    return validTokens;
  } catch (err) {
    console.error('Error fetching eligible teacher tokens for CRON:', err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// INITIALIZE CRON JOBS
// ─────────────────────────────────────────────────────────────
function initCronJobs() {
  console.log('🕒 Initializing Background CRON Jobs...');

  // ⏰ Morning Clock-In Reminder (Mon-Fri at 6:30 AM)
  cron.schedule('30 6 * * 1-5', async () => {
    console.log('CRON [6:30 AM]: Running Morning Clock-In Reminder...');
    const tokens = await getEligibleTeacherTokens();

    if (tokens.length > 0) {
      await sendPushNotifications(
        tokens,
        "Clock In Reminder ⏰",
        "Good morning! Don't forget to clock in when you arrive at school."
      );
      console.log(`✅ Morning reminder sent to ${tokens.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify (Holidays/No Active Term).');
    }
  }, { timezone: 'UTC' });

  // ⏰ Afternoon Clock-Out Reminder (Mon-Fri at 3:30 PM)
  cron.schedule('30 15 * * 1-5', async () => {
    console.log('CRON [3:30 PM]: Running Afternoon Clock-Out Reminder...');
    const tokens = await getEligibleTeacherTokens();

    if (tokens.length > 0) {
      await sendPushNotifications(
        tokens,
        "Clock Out Reminder ⏰",
        "School is over! Don't forget to clock out before you leave."
      );
      console.log(`✅ Afternoon reminder sent to ${tokens.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify.');
    }
  }, { timezone: 'UTC' });

  // 📚 Friday Weekly Exercise Reminder (Friday at 2:00 PM)
  cron.schedule('0 14 * * 5', async () => {
    console.log('CRON [2:00 PM Fri]: Running Weekly Exercise Reminder...');
    const tokens = await getEligibleTeacherTokens();

    if (tokens.length > 0) {
      await sendPushNotifications(
        tokens,
        "Weekly Exercise Reminder 📚",
        "Happy Friday! Please remember to submit the number of exercises for the week."
      );
      console.log(`✅ Friday exercise reminder sent to ${tokens.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify.');
    }
  }, { timezone: 'UTC' });

  console.log('✅ CRON Jobs Registered.');
}

module.exports = initCronJobs;
