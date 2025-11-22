const redis = require('redis');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connect();
  }

  async connect() {
    try {
      this.client = redis.createClient({
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
        },
        password: process.env.REDIS_PASSWORD || undefined,
      });

      this.client.on('error', (err) => {
        console.log('Redis Client Error', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('Redis Client Connected');
        this.isConnected = true;
      });

      await this.client.connect();
    } catch (error) {
      console.log('Redis connection failed, using in-memory cache:', error.message);
      this.isConnected = false;
      // Fallback to in-memory cache
      this.memoryCache = new Map();
    }
  }

  async get(key) {
    if (!this.isConnected || !this.client) {
      return this.memoryCache?.get(key);
    }
    
    try {
      return await this.client.get(key);
    } catch (error) {
      console.log('Redis get failed, using memory cache:', error.message);
      return this.memoryCache?.get(key);
    }
  }

  async setex(key, ttl, value) {
    if (!this.isConnected || !this.client) {
      this.memoryCache?.set(key, value);
      // Simple TTL simulation for memory cache
      setTimeout(() => {
        this.memoryCache?.delete(key);
      }, ttl * 1000);
      return;
    }
    
    try {
      await this.client.setEx(key, ttl, value);
    } catch (error) {
      console.log('Redis setex failed, using memory cache:', error.message);
      this.memoryCache?.set(key, value);
      setTimeout(() => {
        this.memoryCache?.delete(key);
      }, ttl * 1000);
    }
  }

  async del(key) {
    if (!this.isConnected || !this.client) {
      this.memoryCache?.delete(key);
      return;
    }
    
    try {
      await this.client.del(key);
    } catch (error) {
      console.log('Redis del failed:', error.message);
      this.memoryCache?.delete(key);
    }
  }

  async delPattern(pattern) {
    if (!this.isConnected || !this.client) {
      // Simple pattern matching for memory cache
      for (const key of this.memoryCache?.keys() || []) {
        if (key.includes(pattern.replace('*', ''))) {
          this.memoryCache?.delete(key);
        }
      }
      return;
    }
    
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch (error) {
      console.log('Redis delPattern failed:', error.message);
    }
  }
}

module.exports = new RedisClient();