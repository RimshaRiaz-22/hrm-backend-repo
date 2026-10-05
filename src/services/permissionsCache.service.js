/**
 * In-memory per-user cache for the auth context loaded by attachPermissions
 * (user row fields + effective permissions matrix). Avoids hitting the
 * database on every authenticated request.
 *
 * Trade-off: role/permission/is_active changes take up to the TTL to apply.
 * Set PERMISSIONS_CACHE_TTL_MS=0 to disable caching entirely.
 */
const DEFAULT_TTL_MS = 60 * 1000;

const cache = new Map();

function ttlMs() {
  const fromEnv = Number(process.env.PERMISSIONS_CACHE_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_TTL_MS;
}

function getCachedAuthContext(userId) {
  const key = Number(userId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedAuthContext(userId, value) {
  const ttl = ttlMs();
  if (ttl === 0) return;
  cache.set(Number(userId), { value, expiresAt: Date.now() + ttl });
}

function invalidateAuthContext(userId) {
  cache.delete(Number(userId));
}

function invalidateAllAuthContexts() {
  cache.clear();
}

module.exports = {
  getCachedAuthContext,
  setCachedAuthContext,
  invalidateAuthContext,
  invalidateAllAuthContexts,
};
