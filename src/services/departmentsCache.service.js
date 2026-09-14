const crypto = require('crypto');
const { getRedisClient, ensureRedisConnected } = require('../redis');

const PREFIX = 'hrm:departments';
const DEFAULT_TTL_SECONDS = parseInt(process.env.REDIS_DEPARTMENTS_TTL_SECONDS, 10) || 300;
const DEBUG = process.env.REDIS_CACHE_DEBUG === 'true';

function debugLog(message) {
  if (DEBUG) console.log(`[departmentsCache] ${message}`);
}

function hashQueryMeta(queryMeta) {
  return crypto.createHash('sha256').update(JSON.stringify(queryMeta)).digest('hex').slice(0, 16);
}

function listCacheKey(companyId, queryMeta) {
  return `${PREFIX}:list:${companyId}:${hashQueryMeta(queryMeta)}`;
}

function detailCacheKey(deptId, scopeKey) {
  return `${PREFIX}:detail:${scopeKey}:${deptId}`;
}

function summaryCacheKey(companyId) {
  return `${PREFIX}:summary:${companyId}`;
}

function companyListPattern(companyId) {
  return `${PREFIX}:list:${companyId}:*`;
}

function companyDetailPattern(companyId) {
  return `${PREFIX}:detail:${companyId}:*`;
}

async function getCachedJson(key) {
  const connected = await ensureRedisConnected();
  if (!connected) {
    debugLog(`SKIP GET (redis unavailable) key=${key}`);
    return null;
  }

  try {
    const raw = await getRedisClient().get(key);
    if (!raw) {
      debugLog(`MISS key=${key}`);
      return null;
    }
    debugLog(`HIT key=${key}`);
    return JSON.parse(raw);
  } catch (err) {
    console.error('[departmentsCache] get failed:', err.message);
    return null;
  }
}

async function setCachedJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const connected = await ensureRedisConnected();
  if (!connected) return;

  try {
    await getRedisClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
    debugLog(`SET key=${key} ttl=${ttlSeconds}s`);
  } catch (err) {
    console.error('[departmentsCache] set failed:', err.message);
  }
}

async function deleteKeysByPattern(pattern) {
  const connected = await ensureRedisConnected();
  if (!connected) return;

  const redis = getRedisClient();
  let cursor = '0';

  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error('[departmentsCache] delete pattern failed:', err.message);
  }
}

async function invalidateCompanyDepartments(companyId) {
  if (!companyId) return;

  const connected = await ensureRedisConnected();
  if (!connected) return;

  const redis = getRedisClient();
  const summaryKey = summaryCacheKey(companyId);

  try {
    await redis.del(summaryKey);
    await deleteKeysByPattern(companyListPattern(companyId));
    await deleteKeysByPattern(companyDetailPattern(companyId));
    debugLog(`INVALIDATE company_id=${companyId}`);
  } catch (err) {
    console.error('[departmentsCache] invalidate company failed:', err.message);
  }
}

module.exports = {
  listCacheKey,
  detailCacheKey,
  summaryCacheKey,
  getCachedJson,
  setCachedJson,
  invalidateCompanyDepartments,
};
