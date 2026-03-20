const Redis = require('ioredis');
require('dotenv').config();

// Define ioredis connection configuration suitable for BullMQ
const redisConfig = process.env.REDIS_URL || {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null, // Critical requirement for BullMQ
};

// Create a shared standard connection
const redisConnection = new Redis(redisConfig);

redisConnection.on('connect', () => {
  console.log('✅ Connected to ioredis successfully (for BullMQ)');
});

redisConnection.on('error', (err) => {
  console.error('❌ ioredis Connection Error:', err.message);
});

module.exports = {
  redisConnection,
  redisConfig, // Export raw config for BullMQ constructor
};
