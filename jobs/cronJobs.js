const cron = require('node-cron');
const Teacher = require('../models/Teacher');
const Term = require('../models/term');
const Attendance = require('../models/TeacherAttendance');
const { sendPushNotifications } = require('../controllers/notificationController');

/**
 * Helper to fetch teacher user IDs who should receive notifications today.
 * Excludes teachers if their school is not in an active term, if they are marked 
 * as Holiday/Absent today, or if they have already satisfied the reminder condition.
 * @param {string} reminderType - 'CLOCK_IN' | 'CLOCK_OUT' | 'GENERAL'
 */
async function getEligibleTeacherUserIds(reminderType = 'GENERAL') {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  try {
    // 1. Find schools in an active term
    const activeTerms = await Term.find({
      startDate: { $lte: todayEnd },
      endDate: { $gte: todayStart }
    }).select('school').lean();
    
    const activeSchoolIds = [...new Set(activeTerms.map(t => String(t.school)))];

    if (activeSchoolIds.length === 0) return [];

    // 2. Get all teachers in active schools
    const teachers = await Teacher.find({
      school: { $in: activeSchoolIds },
      user: { $exists: true, $ne: null },
    }).select('user school _id').lean();

    // 3. Get all attendance records for today (to check individual status & clock times)
    const todaysAttendances = await Attendance.find({
      date: { $gte: todayStart, $lte: todayEnd }
    }).select('teacher status signInTime signOutTime').lean();

    // Create a map for fast lookup: teacherId -> attendance record
    const attendanceMap = {};
    for (const record of todaysAttendances) {
      attendanceMap[String(record.teacher)] = record;
    }

    const eligibleUserIds = new Set();
    
    for (const t of teachers) {
      const record = attendanceMap[String(t._id)];
      
      // 🛡️ CRITICAL FIX: If marked as Holiday or Absent manually, skip completely!
      if (record && (record.status === 'Holiday' || record.status === 'Absent')) {
        continue; 
      }

      // If it's morning (Clock In reminder), skip if they already clocked in
      if (reminderType === 'CLOCK_IN') {
        if (record && record.signInTime) continue;
      }

      // If it's afternoon (Clock Out reminder), skip if they never clocked in, or already clocked out
      if (reminderType === 'CLOCK_OUT') {
        if (!record || !record.signInTime) continue; // Didn't come to school
        if (record && record.signOutTime) continue; // Already left
      }

      // If they passed all filters, they are eligible
      eligibleUserIds.add(String(t.user));
    }

    return [...eligibleUserIds];
  } catch (err) {
    console.error('Error fetching eligible teacher user IDs for CRON:', err);
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
    const userIds = await getEligibleTeacherUserIds('CLOCK_IN');

    if (userIds.length > 0) {
      await sendPushNotifications(
        userIds,
        "Clock In Reminder ⏰",
        "Good morning! Don't forget to clock in when you arrive at school."
      );
      console.log(`✅ Morning reminder queued for ${userIds.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify (Holidays/Already Clocked In/No Active Term).');
    }
  }, { timezone: 'UTC' });

  // ⏰ Afternoon Clock-Out Reminder (Mon-Fri at 3:30 PM)
  cron.schedule('30 15 * * 1-5', async () => {
    console.log('CRON [3:30 PM]: Running Afternoon Clock-Out Reminder...');
    const userIds = await getEligibleTeacherUserIds('CLOCK_OUT');

    if (userIds.length > 0) {
      await sendPushNotifications(
        userIds,
        "Clock Out Reminder ⏰",
        "School is over! Don't forget to clock out before you leave."
      );
      console.log(`✅ Afternoon reminder queued for ${userIds.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify (Holidays/Already Clocked Out/Absent).');
    }
  }, { timezone: 'UTC' });

  // 📚 Friday Weekly Exercise Reminder (Friday at 2:00 PM)
  cron.schedule('0 14 * * 5', async () => {
    console.log('CRON [2:00 PM Fri]: Running Weekly Exercise Reminder...');
    const userIds = await getEligibleTeacherUserIds('GENERAL');

    if (userIds.length > 0) {
      await sendPushNotifications(
        userIds,
        "Weekly Exercise Reminder 📚",
        "Happy Friday! Please remember to submit the number of exercises for the week."
      );
      console.log(`✅ Friday exercise reminder queued for ${userIds.length} teachers.`);
    } else {
      console.log('ℹ️ No eligible teachers to notify.');
    }
  }, { timezone: 'UTC' });

  // 💰 Friday Weekly Summary for Daily School Fees (Friday at 4:00 PM)
  cron.schedule('0 16 * * 5', async () => {
    console.log('CRON [4:00 PM Fri]: Running Weekly Daily School Fees SMS Summary...');
    const smsController = require('../controllers/smsController');
    await smsController.processAllWeeklyDailyFeesSMS();
  }, { timezone: 'UTC' });

  console.log('✅ CRON Jobs Registered.');
}

module.exports = initCronJobs;
