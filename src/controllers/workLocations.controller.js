const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { resolveTimezoneFromCoordinates } = require('../utils/coordinatesTimezone');

const MAX_NAME_LEN = 120;
const MAX_COUNTRY_LEN = 80;
const MAX_CITY_LEN = 80;
const MAX_POSTAL_CODE_LEN = 30;
const MAX_ADDRESS_LEN = 500;
const DEFAULT_RADIUS_METERS = 1000;
const SORT_FIELDS = new Map([
  ['id', 'id'],
  ['name', 'name'],
  ['country', 'country'],
  ['city', 'city'],
  ['postal_code', 'postal_code'],
  ['radius_meters', 'radius_meters'],
  ['created_at', 'created_at'],
  ['updated_at', 'updated_at'],
]);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseRequiredText(value, fieldName, maxLen) {
  const s = String(value || '').trim();
  if (!s) return { error: `${fieldName} is required.` };
  if (s.length > maxLen) return { error: `${fieldName} must be at most ${maxLen} characters.` };
  return { value: s };
}

function parseOptionalText(value, fieldName, maxLen) {
  if (value === undefined || value === null) return { value: null };
  const s = String(value).trim();
  if (!s) return { value: null };
  if (s.length > maxLen) return { error: `${fieldName} must be at most ${maxLen} characters.` };
  return { value: s };
}

function parseCoordinate(value, fieldName, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { error: `${fieldName} must be a number between ${min} and ${max}.` };
  }
  return { value: n };
}

function parseRadiusMeters(body) {
  const raw = body.radius_meters ?? body.radius;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_RADIUS_METERS };
  }

  let radius = Number(raw);
  const unit = String(body.radius_unit || 'meters').trim().toLowerCase();
  if (unit === 'km' || unit === 'kilometer' || unit === 'kilometers') {
    radius *= 1000;
  }

  if (!Number.isInteger(radius) || radius < 1 || radius > 50000) {
    return { error: 'radius_meters must be an integer between 1 and 50000.' };
  }
  return { value: radius };
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return { value: defaultValue };
  if (value === true || value === 'true' || value === 1 || value === '1') return { value: true };
  if (value === false || value === 'false' || value === 0 || value === '0') return { value: false };
  return { error: true };
}

function parseGeofencingEnabled(value) {
  const parsed = parseBooleanFlag(value, false);
  if (parsed.error) return { error: 'geofencing_enabled must be true or false.' };
  return parsed;
}

function parseIsActive(value, defaultValue = true) {
  const parsed = parseBooleanFlag(value, defaultValue);
  if (parsed.error) return { error: 'is_active must be true or false.' };
  return parsed;
}

function mapWorkLocationRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    country: row.country,
    city: row.city,
    postal_code: row.postal_code,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone ?? null,
    radius_meters: Number(row.radius_meters),
    radius_km: Number((Number(row.radius_meters) / 1000).toFixed(3)),
    address: row.address,
    geofencing_enabled: Boolean(row.geofencing_enabled),
    is_active: Boolean(row.is_active),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function parseSort(query = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'name').trim();
  const sortBy = SORT_FIELDS.get(sortByRaw);
  if (!sortBy) {
    return {
      error: `sort_by must be one of: ${Array.from(SORT_FIELDS.keys()).join(', ')}.`,
    };
  }

  const orderRaw = String(query.sort_order || query.sortOrder || 'asc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(orderRaw)) {
    return { error: 'sort_order must be asc or desc.' };
  }

  return {
    orderBySql: `${sortBy} ${orderRaw.toUpperCase()}, id DESC`,
    sort_by: sortByRaw,
    sort_order: orderRaw,
  };
}

async function getAuthenticatedCompanyAdmin(req) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [req.authUser.userId, req.authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const admin = result.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active) {
    return { error: [403, 'Your account is inactive. Please contact support.'] };
  }
  return { admin };
}

async function canAdminAccessCompany(admin, companyId) {
  const result = await pool.query(
    `SELECT id
     FROM companies
     WHERE id = $1
       AND is_active = true
       AND (super_admin_id = $2 OR ($3::bigint IS NOT NULL AND id = $3))`,
    [companyId, admin.id, admin.company_id ?? null]
  );
  return result.rowCount > 0;
}

function validateCreatePayload(body) {
  const companyId = parsePositiveInt(body.company_id);
  if (!companyId) return { error: 'company_id is required and must be a positive integer.' };

  const name = parseRequiredText(body.name, 'name', MAX_NAME_LEN);
  if (name.error) return { error: name.error };
  const country = parseRequiredText(body.country, 'country', MAX_COUNTRY_LEN);
  if (country.error) return { error: country.error };
  const city = parseRequiredText(body.city, 'city', MAX_CITY_LEN);
  if (city.error) return { error: city.error };
  const postalCode = parseOptionalText(body.postal_code ?? body.postalCode, 'postal_code', MAX_POSTAL_CODE_LEN);
  if (postalCode.error) return { error: postalCode.error };
  const latitude = parseCoordinate(body.latitude, 'latitude', -90, 90);
  if (latitude.error) return { error: latitude.error };
  const longitude = parseCoordinate(body.longitude, 'longitude', -180, 180);
  if (longitude.error) return { error: longitude.error };
  const radius = parseRadiusMeters(body);
  if (radius.error) return { error: radius.error };
  const address = parseRequiredText(body.address, 'address', MAX_ADDRESS_LEN);
  if (address.error) return { error: address.error };
  const geofencing = parseGeofencingEnabled(body.geofencing_enabled ?? body.geofencingEnabled);
  if (geofencing.error) return { error: geofencing.error };
  const isActive = parseIsActive(body.is_active, true);
  if (isActive.error) return { error: isActive.error };

  return {
    value: {
      companyId,
      name: name.value,
      country: country.value,
      city: city.value,
      postalCode: postalCode.value,
      latitude: latitude.value,
      longitude: longitude.value,
      radiusMeters: radius.value,
      address: address.value,
      geofencingEnabled: geofencing.value,
      isActive: isActive.value,
    },
  };
}

async function createWorkLocation(req, res) {
  const parsed = validateCreatePayload(req.body || {});
  if (parsed.error) return sendError(res, 400, parsed.error);
  const v = parsed.value;

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    const allowed = await canAdminAccessCompany(auth.admin, v.companyId);
    if (!allowed) return sendError(res, 403, 'You can only manage work locations for your own company.');

    const nowUtc = utcNowForPgTimestamp();
    const timezone = resolveTimezoneFromCoordinates(v.latitude, v.longitude);
    const inserted = await pool.query(
      `INSERT INTO attendance_location_settings (
         company_id, name, country, city, postal_code, latitude, longitude,
         radius_meters, address, geofencing_enabled, is_active, timezone, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamp, $13::timestamp)
       RETURNING *`,
      [
        v.companyId,
        v.name,
        v.country,
        v.city,
        v.postalCode,
        v.latitude,
        v.longitude,
        v.radiusMeters,
        v.address,
        v.geofencingEnabled,
        v.isActive,
        timezone,
        nowUtc,
      ]
    );

    return sendSuccess(res, 201, 'Work location created successfully.', {
      work_location: mapWorkLocationRow(inserted.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A work location with this name already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createWorkLocation error:', error);
    return sendError(res, 500, 'Something went wrong while creating work location.');
  }
}

async function getWorkLocations(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);
  const sort = parseSort(req.query);
  if (sort.error) return sendError(res, 400, sort.error);
  const search = String(req.query?.search || '').trim();

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only view work locations for your own company.');

    const values = [companyId];
    let searchClause = '';
    if (search) {
      values.push(`%${search}%`);
      searchClause = `AND (name ILIKE $2 OR country ILIKE $2 OR city ILIKE $2 OR address ILIKE $2)`;
    }

    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM attendance_location_settings WHERE company_id = $1 ${searchClause}`,
      values
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `SELECT * FROM attendance_location_settings
           WHERE company_id = $1 ${searchClause}
           ORDER BY ${sort.orderBySql}`,
          values
        )
      : await pool.query(
          `SELECT * FROM attendance_location_settings
           WHERE company_id = $1 ${searchClause}
           ORDER BY ${sort.orderBySql}
           LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, listPagination.pagination.limit, listPagination.pagination.offset]
        );

    return sendSuccess(res, 200, 'Work locations fetched successfully.', {
      work_locations: result.rows.map(mapWorkLocationRow),
      pagination: buildListPaginationMeta(count.rows[0]?.total, listPagination),
      sort: {
        sort_by: sort.sort_by,
        sort_order: sort.sort_order,
      },
    });
  } catch (error) {
    console.error('getWorkLocations error:', error);
    return sendError(res, 500, 'Something went wrong while fetching work locations.');
  }
}

async function getWorkLocationById(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Work location id must be a positive integer.');
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only view work locations for your own company.');

    const result = await pool.query('SELECT * FROM attendance_location_settings WHERE id = $1 AND company_id = $2', [
      id,
      companyId,
    ]);
    if (result.rowCount === 0) return sendError(res, 404, 'Work location not found.');
    return sendSuccess(res, 200, 'Work location fetched successfully.', {
      work_location: mapWorkLocationRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getWorkLocationById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching work location.');
  }
}

async function updateWorkLocation(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Work location id must be a positive integer.');

  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id ?? req.query?.company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set([
    'company_id',
    'name',
    'country',
    'city',
    'postal_code',
    'postalCode',
    'latitude',
    'longitude',
    'radius',
    'radius_meters',
    'radius_unit',
    'address',
    'geofencing_enabled',
    'geofencingEnabled',
    'is_active',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return sendError(res, 400, `Unknown field "${key}".`);
  }

  const updates = [];
  const values = [];
  let idx = 1;
  const add = (sql, value) => {
    updates.push(`${sql} = $${idx++}`);
    values.push(value);
  };

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const parsed = parseRequiredText(body.name, 'name', MAX_NAME_LEN);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('name', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'country')) {
    const parsed = parseRequiredText(body.country, 'country', MAX_COUNTRY_LEN);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('country', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'city')) {
    const parsed = parseRequiredText(body.city, 'city', MAX_CITY_LEN);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('city', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'postal_code') || Object.prototype.hasOwnProperty.call(body, 'postalCode')) {
    const parsed = parseOptionalText(body.postal_code ?? body.postalCode, 'postal_code', MAX_POSTAL_CODE_LEN);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('postal_code', parsed.value);
  }
  let newLatitude;
  let hasLatitude = false;
  if (Object.prototype.hasOwnProperty.call(body, 'latitude')) {
    const parsed = parseCoordinate(body.latitude, 'latitude', -90, 90);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('latitude', parsed.value);
    newLatitude = parsed.value;
    hasLatitude = true;
  }
  let newLongitude;
  let hasLongitude = false;
  if (Object.prototype.hasOwnProperty.call(body, 'longitude')) {
    const parsed = parseCoordinate(body.longitude, 'longitude', -180, 180);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('longitude', parsed.value);
    newLongitude = parsed.value;
    hasLongitude = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'radius') || Object.prototype.hasOwnProperty.call(body, 'radius_meters')) {
    const parsed = parseRadiusMeters(body);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('radius_meters', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'address')) {
    const parsed = parseRequiredText(body.address, 'address', MAX_ADDRESS_LEN);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('address', parsed.value);
  }
  if (
    Object.prototype.hasOwnProperty.call(body, 'geofencing_enabled') ||
    Object.prototype.hasOwnProperty.call(body, 'geofencingEnabled')
  ) {
    const parsed = parseGeofencingEnabled(body.geofencing_enabled ?? body.geofencingEnabled);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('geofencing_enabled', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    const parsed = parseIsActive(body.is_active, true);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('is_active', parsed.value);
  }

  if (updates.length === 0) {
    return sendError(res, 400, 'Provide at least one field to update besides company_id.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only update work locations for your own company.');

    if (hasLatitude || hasLongitude) {
      let finalLat = newLatitude;
      let finalLng = newLongitude;
      if (!hasLatitude || !hasLongitude) {
        const current = await pool.query(
          'SELECT latitude, longitude FROM attendance_location_settings WHERE id = $1 AND company_id = $2',
          [id, companyId]
        );
        if (current.rowCount === 0) return sendError(res, 404, 'Work location not found.');
        if (!hasLatitude) finalLat = current.rows[0].latitude;
        if (!hasLongitude) finalLng = current.rows[0].longitude;
      }
      add('timezone', resolveTimezoneFromCoordinates(finalLat, finalLng));
    }

    const nowUtc = utcNowForPgTimestamp();
    values.push(id, companyId);
    const idPos = idx++;
    const companyPos = idx++;
    values.push(nowUtc);
    const updatedAtPos = idx++;
    const updated = await pool.query(
      `UPDATE attendance_location_settings
       SET ${updates.join(', ')}, updated_at = $${updatedAtPos}::timestamp
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Work location not found.');
    return sendSuccess(res, 200, 'Work location updated successfully.', {
      work_location: mapWorkLocationRow(updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A work location with this name already exists for this company.');
    }
    console.error('updateWorkLocation error:', error);
    return sendError(res, 500, 'Something went wrong while updating work location.');
  }
}

async function deleteWorkLocation(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Work location id must be a positive integer.');
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only delete work locations for your own company.');

    const assigned = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM employee_job_details
       WHERE company_id = $1 AND work_location_id = $2`,
      [companyId, id]
    );
    if (Number(assigned.rows[0]?.total || 0) > 0) {
      return sendError(res, 409, 'Cannot delete a work location assigned to employees.');
    }

    const deleted = await pool.query('DELETE FROM attendance_location_settings WHERE id = $1 AND company_id = $2 RETURNING *', [
      id,
      companyId,
    ]);
    if (deleted.rowCount === 0) return sendError(res, 404, 'Work location not found.');
    return sendSuccess(res, 200, 'Work location deleted successfully.', {
      work_location: mapWorkLocationRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteWorkLocation error:', error);
    return sendError(res, 500, 'Something went wrong while deleting work location.');
  }
}

module.exports = {
  createWorkLocation,
  getWorkLocations,
  getWorkLocationById,
  updateWorkLocation,
  deleteWorkLocation,
};
