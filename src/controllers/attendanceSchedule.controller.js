const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parsePagination, buildPaginationMeta } = require('../services/pagination.service');

const WEEKDAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const MAX_ADDRESS_LEN = 500;
const MAX_LOCATION_NAME_LEN = 120;
const MAX_COUNTRY_LEN = 80;
const MAX_CITY_LEN = 80;
const MAX_POSTAL_CODE_LEN = 30;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeTime(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s;
}

function parseBreakGrace(value, fieldName, defaultVal) {
  if (value === undefined || value === null || value === '') return { ok: true, value: defaultVal };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, message: `${fieldName} must be a non-negative integer.` };
  }
  const max = fieldName === 'break_minutes' ? 480 : 240;
  if (n > max) {
    return { ok: false, message: `${fieldName} must be at most ${max}.` };
  }
  return { ok: true, value: n };
}

/** Returns { ok, working_days } or { ok: false, message } */
function parseWorkingDays(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'working_days must be a non-empty array of weekday names.' };
  }
  const out = [];
  for (const raw of value) {
    const d = String(raw || '')
      .trim()
      .toLowerCase();
    if (!WEEKDAYS.has(d)) {
      return {
        ok: false,
        message: `Invalid working day "${raw}". Use: monday, tuesday, wednesday, thursday, friday, saturday, sunday.`,
      };
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length === 0) {
    return { ok: false, message: 'working_days must contain at least one valid weekday.' };
  }
  return { ok: true, working_days: out };
}

function parseOptionalLatLng(lat, lng) {
  const hasLat = lat !== undefined && lat !== null && String(lat).trim() !== '';
  const hasLng = lng !== undefined && lng !== null && String(lng).trim() !== '';
  if (!hasLat && !hasLng) return { ok: true, latitude: null, longitude: null };
  if (hasLat !== hasLng) {
    return { ok: false, message: 'latitude and longitude must both be provided together, or both omitted.' };
  }
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, message: 'latitude and longitude must be valid numbers.' };
  }
  if (latitude < -90 || latitude > 90) {
    return { ok: false, message: 'latitude must be between -90 and 90.' };
  }
  if (longitude < -180 || longitude > 180) {
    return { ok: false, message: 'longitude must be between -180 and 180.' };
  }
  return { ok: true, latitude, longitude };
}

function parseAddress(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > MAX_ADDRESS_LEN) {
    return { error: `address must be at most ${MAX_ADDRESS_LEN} characters.` };
  }
  return { value: s };
}

function parseLocationName(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > MAX_LOCATION_NAME_LEN) {
    return { error: `location_name must be at most ${MAX_LOCATION_NAME_LEN} characters.` };
  }
  return { value: s };
}

function parseCountry(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > MAX_COUNTRY_LEN) {
    return { error: `country must be at most ${MAX_COUNTRY_LEN} characters.` };
  }
  return { value: s };
}

function parseCity(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > MAX_CITY_LEN) {
    return { error: `city must be at most ${MAX_CITY_LEN} characters.` };
  }
  return { value: s };
}

function parsePostalCode(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > MAX_POSTAL_CODE_LEN) {
    return { error: `postal_code must be at most ${MAX_POSTAL_CODE_LEN} characters.` };
  }
  return { value: s };
}

function parseRadius(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, radius_meters: null };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50000) {
    return { ok: false, message: 'radius must be an integer between 1 and 50000.' };
  }
  return { ok: true, radius_meters: n };
}

function mapWorkingDaysFromRow(row) {
  const w = row.working_days;
  if (Array.isArray(w)) return w;
  if (w && typeof w === 'object') return Object.keys(w).length ? Object.values(w) : [];
  return [];
}

function mapAttendanceScheduleRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    working_days: mapWorkingDaysFromRow(row),
    shift_start: row.shift_start != null ? String(row.shift_start).slice(0, 8) : null,
    shift_end: row.shift_end != null ? String(row.shift_end).slice(0, 8) : null,
    break_minutes: Number(row.break_minutes ?? 0),
    grace_minutes: Number(row.grace_minutes ?? 0),
    location_name: row.location_name ?? null,
    country: row.country ?? null,
    city: row.city ?? null,
    postal_code: row.postal_code ?? null,
    address: row.address ?? null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    radius: row.radius_meters != null ? Number(row.radius_meters) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
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

/** POST /api/v1/attendance-schedules */
async function createAttendanceSchedule(req, res) {
  const b = req.body || {};
  const companyId = parsePositiveInt(b.company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const wd = parseWorkingDays(b.working_days);
  if (!wd.ok) return sendError(res, 400, wd.message);

  const shiftStart = normalizeTime(b.shift_start);
  const shiftEnd = normalizeTime(b.shift_end);
  if (!shiftStart) return sendError(res, 400, 'shift_start is required.');
  if (!shiftEnd) return sendError(res, 400, 'shift_end is required.');

  const br = parseBreakGrace(b.break_minutes, 'break_minutes', 0);
  if (!br.ok) return sendError(res, 400, br.message);
  const gr = parseBreakGrace(b.grace_minutes, 'grace_minutes', 0);
  if (!gr.ok) return sendError(res, 400, gr.message);

  const locationName = parseLocationName(b.location_name);
  if (locationName && locationName.error) return sendError(res, 400, locationName.error);
  const country = parseCountry(b.country);
  if (country && country.error) return sendError(res, 400, country.error);
  const city = parseCity(b.city);
  if (city && city.error) return sendError(res, 400, city.error);
  const postalCode = parsePostalCode(b.postal_code);
  if (postalCode && postalCode.error) return sendError(res, 400, postalCode.error);
  const addr = parseAddress(b.address);
  if (addr && addr.error) return sendError(res, 400, addr.error);
  const ll = parseOptionalLatLng(b.latitude, b.longitude);
  if (!ll.ok) return sendError(res, 400, ll.message);
  const radius = parseRadius(b.radius);
  if (!radius.ok) return sendError(res, 400, radius.message);

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only manage attendance schedules for your own company.');

    const insert = await pool.query(
      `INSERT INTO attendance_schedules (
         company_id, working_days, shift_start, shift_end,
         break_minutes, grace_minutes,
         location_name, country, city, postal_code, address,
         latitude, longitude, radius_meters,
         created_at, updated_at
       )
       VALUES ($1, $2::jsonb, $3::time, $4::time, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
       RETURNING *`,
      [
        companyId,
        JSON.stringify(wd.working_days),
        shiftStart,
        shiftEnd,
        br.value,
        gr.value,
        locationName?.value ?? null,
        country?.value ?? null,
        city?.value ?? null,
        postalCode?.value ?? null,
        addr?.value ?? null,
        ll.latitude,
        ll.longitude,
        radius.radius_meters,
      ]
    );

    return sendSuccess(res, 201, 'Attendance schedule created successfully.', {
      attendance_schedule: mapAttendanceScheduleRow(insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '22007' || error?.code === '23514') {
      return sendError(res, 400, 'Invalid shift_start or shift_end time format. Use HH:MM or HH:MM:SS.');
    }
    console.error('createAttendanceSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while creating attendance schedule.');
  }
}

/** GET /api/v1/attendance-schedules?company_id= */
async function getAttendanceSchedules(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const pagination = parsePagination(req.query);
  if (pagination.error) return sendError(res, 400, pagination.error);

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only view attendance schedules for your own company.');

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM attendance_schedules WHERE company_id = $1`,
      [companyId]
    );

    const result = await pool.query(
      `SELECT * FROM attendance_schedules
       WHERE company_id = $1
       ORDER BY id DESC
       LIMIT $2 OFFSET $3`,
      [companyId, pagination.limit, pagination.offset]
    );

    return sendSuccess(res, 200, 'Attendance schedules fetched successfully.', {
      attendance_schedules: result.rows.map(mapAttendanceScheduleRow),
      pagination: buildPaginationMeta(countResult.rows[0]?.total, pagination.page, pagination.limit),
    });
  } catch (error) {
    console.error('getAttendanceSchedules error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance schedules.');
  }
}

/** GET /api/v1/attendance-schedules/:id?company_id= */
async function getAttendanceScheduleById(req, res) {
  const scheduleId = parsePositiveInt(req.params.id);
  if (!scheduleId) return sendError(res, 400, 'Attendance schedule id must be a positive integer.');

  const companyId = req.query?.company_id ? parsePositiveInt(req.query.company_id) : null;
  if (req.query?.company_id && !companyId) {
    return sendError(res, 400, 'company_id query parameter must be a positive integer when provided.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    let result;
    if (companyId) {
      const allowed = await canAdminAccessCompany(auth.admin, companyId);
      if (!allowed) return sendError(res, 403, 'You can only view attendance schedules for your own company.');
      result = await pool.query(
        `SELECT * FROM attendance_schedules WHERE id = $1 AND company_id = $2`,
        [scheduleId, companyId]
      );
    } else {
      result = await pool.query(
        `SELECT s.*
         FROM attendance_schedules s
         WHERE s.id = $1
           AND s.company_id IN (
             SELECT c2.id
             FROM companies c2
             WHERE c2.is_active = true
               AND (c2.super_admin_id = $2 OR ($3::bigint IS NOT NULL AND c2.id = $3))
           )`,
        [scheduleId, auth.admin.id, auth.admin.company_id ?? null]
      );
    }

    if (result.rowCount === 0) return sendError(res, 404, 'Attendance schedule not found.');
    return sendSuccess(res, 200, 'Attendance schedule fetched successfully.', {
      attendance_schedule: mapAttendanceScheduleRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getAttendanceScheduleById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance schedule.');
  }
}

/** PATCH /api/v1/attendance-schedules/:id */
async function updateAttendanceSchedule(req, res) {
  const scheduleId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!scheduleId) return sendError(res, 400, 'Attendance schedule id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set([
    'company_id',
    'working_days',
    'shift_start',
    'shift_end',
    'break_minutes',
    'grace_minutes',
    'location_name',
    'country',
    'city',
    'postal_code',
    'address',
    'latitude',
    'longitude',
    'radius',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return sendError(res, 400, `Unknown field "${key}".`);
    }
  }

  const hasUpdate =
    Object.prototype.hasOwnProperty.call(body, 'working_days') ||
    Object.prototype.hasOwnProperty.call(body, 'shift_start') ||
    Object.prototype.hasOwnProperty.call(body, 'shift_end') ||
    Object.prototype.hasOwnProperty.call(body, 'break_minutes') ||
    Object.prototype.hasOwnProperty.call(body, 'grace_minutes') ||
    Object.prototype.hasOwnProperty.call(body, 'location_name') ||
    Object.prototype.hasOwnProperty.call(body, 'country') ||
    Object.prototype.hasOwnProperty.call(body, 'city') ||
    Object.prototype.hasOwnProperty.call(body, 'postal_code') ||
    Object.prototype.hasOwnProperty.call(body, 'address') ||
    Object.prototype.hasOwnProperty.call(body, 'latitude') ||
    Object.prototype.hasOwnProperty.call(body, 'longitude') ||
    Object.prototype.hasOwnProperty.call(body, 'radius');

  if (!hasUpdate) {
    return sendError(res, 400, 'Provide at least one field to update besides company_id.');
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (Object.prototype.hasOwnProperty.call(body, 'working_days')) {
    const wd = parseWorkingDays(body.working_days);
    if (!wd.ok) return sendError(res, 400, wd.message);
    updates.push(`working_days = $${idx++}::jsonb`);
    values.push(JSON.stringify(wd.working_days));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'shift_start')) {
    const t = normalizeTime(body.shift_start);
    if (!t) return sendError(res, 400, 'shift_start cannot be empty.');
    updates.push(`shift_start = $${idx++}::time`);
    values.push(t);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'shift_end')) {
    const t = normalizeTime(body.shift_end);
    if (!t) return sendError(res, 400, 'shift_end cannot be empty.');
    updates.push(`shift_end = $${idx++}::time`);
    values.push(t);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'break_minutes')) {
    const br = parseBreakGrace(body.break_minutes, 'break_minutes', 0);
    if (!br.ok) return sendError(res, 400, br.message);
    updates.push(`break_minutes = $${idx++}`);
    values.push(br.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'grace_minutes')) {
    const gr = parseBreakGrace(body.grace_minutes, 'grace_minutes', 0);
    if (!gr.ok) return sendError(res, 400, gr.message);
    updates.push(`grace_minutes = $${idx++}`);
    values.push(gr.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'location_name')) {
    const locationName = parseLocationName(body.location_name);
    if (locationName && locationName.error) return sendError(res, 400, locationName.error);
    updates.push(`location_name = $${idx++}`);
    values.push(locationName?.value ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'country')) {
    const country = parseCountry(body.country);
    if (country && country.error) return sendError(res, 400, country.error);
    updates.push(`country = $${idx++}`);
    values.push(country?.value ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'city')) {
    const city = parseCity(body.city);
    if (city && city.error) return sendError(res, 400, city.error);
    updates.push(`city = $${idx++}`);
    values.push(city?.value ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'postal_code')) {
    const postalCode = parsePostalCode(body.postal_code);
    if (postalCode && postalCode.error) return sendError(res, 400, postalCode.error);
    updates.push(`postal_code = $${idx++}`);
    values.push(postalCode?.value ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'address')) {
    const addr = parseAddress(body.address);
    if (addr && addr.error) return sendError(res, 400, addr.error);
    updates.push(`address = $${idx++}`);
    values.push(addr?.value ?? null);
  }
  if (
    Object.prototype.hasOwnProperty.call(body, 'latitude') ||
    Object.prototype.hasOwnProperty.call(body, 'longitude')
  ) {
    const ll = parseOptionalLatLng(body.latitude, body.longitude);
    if (!ll.ok) return sendError(res, 400, ll.message);
    updates.push(`latitude = $${idx++}`);
    values.push(ll.latitude);
    updates.push(`longitude = $${idx++}`);
    values.push(ll.longitude);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'radius')) {
    const radius = parseRadius(body.radius);
    if (!radius.ok) return sendError(res, 400, radius.message);
    updates.push(`radius_meters = $${idx++}`);
    values.push(radius.radius_meters);
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only update attendance schedules for your own company.');

    values.push(scheduleId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE attendance_schedules
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Attendance schedule not found.');

    return sendSuccess(res, 200, 'Attendance schedule updated successfully.', {
      attendance_schedule: mapAttendanceScheduleRow(updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '22007' || error?.code === '23514') {
      return sendError(res, 400, 'Invalid shift_start or shift_end time format. Use HH:MM or HH:MM:SS.');
    }
    console.error('updateAttendanceSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while updating attendance schedule.');
  }
}

/** DELETE /api/v1/attendance-schedules/:id?company_id= */
async function deleteAttendanceSchedule(req, res) {
  const scheduleId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!scheduleId) return sendError(res, 400, 'Attendance schedule id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only delete attendance schedules for your own company.');

    const deleted = await pool.query(
      `DELETE FROM attendance_schedules WHERE id = $1 AND company_id = $2 RETURNING *`,
      [scheduleId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Attendance schedule not found.');

    return sendSuccess(res, 200, 'Attendance schedule deleted successfully.', {
      attendance_schedule: mapAttendanceScheduleRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteAttendanceSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while deleting attendance schedule.');
  }
}

module.exports = {
  createAttendanceSchedule,
  getAttendanceSchedules,
  getAttendanceScheduleById,
  updateAttendanceSchedule,
  deleteAttendanceSchedule,
};
