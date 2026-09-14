const Redis = require('ioredis');

let client = null;
let ready = false;

function isRedisEnabled() {
  return process.env.REDIS_ENABLED !== 'false';
}

function getRedisClient() {
  if (!isRedisEnabled()) return null;
  if (client) return client;

  const options = {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
  };

  if (process.env.REDIS_URL) {
    client = new Redis(process.env.REDIS_URL, options);
  } else {
    client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      ...options,
    });
  }

  client.on('ready', () => {
    ready = true;
  });

  client.on('error', (err) => {
    ready = false;
    console.error('[redis] error:', err.message);
  });

  client.on('end', () => {
    ready = false;
  });

  return client;
}

async function ensureRedisConnected() {
  const redis = getRedisClient();
  if (!redis) return false;
  if (ready) return true;

  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    await redis.ping();
    ready = true;
    return true;
  } catch (err) {
    ready = false;
    console.error('[redis] connect failed:', err.message);
    return false;
  }
}

function isRedisReady() {
  return Boolean(client && ready);
}

module.exports = {
  getRedisClient,
  ensureRedisConnected,
  isRedisReady,
  isRedisEnabled,
};
