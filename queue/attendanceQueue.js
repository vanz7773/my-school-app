const { Queue } = require('bullmq');
const { redisConnection } = require('../config/ioredis');

// Create the attendance queue
const attendanceQueue = new Queue('AttendanceQueue', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true, // Clean up successful jobs
    removeOnFail: false,    // Keep failed jobs for inspection/retry
    attempts: 3,            // Retry failed jobs up to 3 times
    backoff: {
      type: 'exponential',
      delay: 1000,          // 1s, 2s, 4s delay between retries
    },
  },
});

module.exports = {
  attendanceQueue,
};
