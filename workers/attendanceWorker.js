const { Worker } = require('bullmq');
const { redisConnection } = require('../config/ioredis');
const { processAttendanceJob } = require('../controllers/studentAttendanceController');
const { processFeedingJob } = require('../controllers/feedingFeeController');
const { processTransportJob } = require('../controllers/transportController');

console.log('👷‍♂️ Starting Attendance/Feeding/Transport Worker...');

// Initialize the worker to process 'AttendanceQueue'
const attendanceWorker = new Worker('AttendanceQueue', async (job) => {
  if (job.name === 'markAttendance') {
    console.log(`⏳ Processing Attendance Job ${job.id} for class ${job.data.classId} / Week ${job.data.week}`);
    const result = await processAttendanceJob(job.data);
    return result;
  }
  
  if (job.name === 'markFeeding') {
    console.log(`🍔 Processing Feeding Fee Job ${job.id} for student ${job.data.student} - ${job.data.day}`);
    const result = await processFeedingJob(job.data);
    return result;
  }

  if (job.name === 'markTransport') {
    console.log(`🚌 Processing Transport Job ${job.id} for student ${job.data.studentId} - ${job.data.day}`);
    const result = await processTransportJob(job.data);
    return result;
  }
}, { 
  connection: redisConnection,
  concurrency: 1 // STRICTLY SEQUENTIAL: Process 1 at a time to prevent MongoDB VersionError overwrites on the same FeedingFeeRecord
});

// Event listeners for monitoring
attendanceWorker.on('completed', (job, returnvalue) => {
  console.log(`✅ Attendance Job ${job.id} completed! Updated ${returnvalue?.updated || 0} students.`);
});

attendanceWorker.on('failed', (job, err) => {
  console.error(`❌ Attendance Job ${job.id} failed:`, err.message);
});

module.exports = {
  attendanceWorker
};
