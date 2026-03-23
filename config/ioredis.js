const Redis = require('ioredis');
require('dotenv').config();

// Create connection config for BullMQ
const redisOptions = {
  maxRetriesPerRequest: null, // Critical requirement for BullMQ
  enableReadyCheck: false
};

// If REDIS_URL exists, use it with the required options, else use localhost
const redisConnection = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL, redisOptions)
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      ...redisOptions
    });

redisConnection.on('connect', async () => {
  console.log('✅ Connected to ioredis successfully (for BullMQ)');
  try {
    await redisConnection.config('SET', 'maxmemory-policy', 'noeviction');
    console.log('✅ Redis config updated successfully: maxmemory-policy = noeviction');
  } catch (err) {
    console.log('⚠️ Note: Could not auto-set Redis maxmemory-policy. You may need to do this manually if Redis lacks admin permissions.', err.message);
  }
});

redisConnection.on('error', (err) => {
  console.error('❌ ioredis Connection Error:', err.message);
});

module.exports = {
  redisConnection
};
