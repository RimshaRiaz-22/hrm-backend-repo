const tzlookup = require('tz-lookup');

/** Offline lat/long -> IANA timezone lookup. Returns null for invalid input or unresolvable coordinates (e.g. open ocean). */
function resolveTimezoneFromCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  try {
    return tzlookup(lat, lng) || null;
  } catch {
    return null;
  }
}

module.exports = {
  resolveTimezoneFromCoordinates,
};
