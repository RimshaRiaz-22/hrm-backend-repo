const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const WEEKDAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
const SORT_FIELDS = new Map([
  ['id', 'id'],
  ['name', 'name'],
  ['start_time', 'start_time'],
  ['end_time', 'end_time'],
  ['created_at', 'created_at'],
  ['updated_at', 'updated_at'],
]);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeTime(value, fieldName, required = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return required ? { error: `${fieldName} is required.` } : { value: null };
  }
  const s = String(value).trim();
  if (!TIME_REGEX.test(s)) return { error: `${fieldName} must be in HH:MM or HH:MM:SS format.` };
  return { value: s.length === 5 ? `${s}:00` : s };
}

function minutesFromTime(time) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function durationMinutes(startTime, endTime) {
  const start = minutesFromTime(startTime);
  const end = minutesFromTime(endTime);
  if (start === null || end === null) return 0;
  return end >= start ? end - start : end + 1440 - start;
}

function parseWorkingDays(value, required = false) {
  if (value === undefined || value === null || value === '') {
    return required ? { error: 'working_days is required.' } : { value: null };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'working_days must be a non-empty array of weekday names.' };
  }

  const days = [];
  for (const raw of value) {
    const day = String(raw || '').trim().toLowerCase();
    if (!WEEKDAYS.has(day)) {
      return {
        error:
          'working_days can only contain: monday, tuesday, wednesday, thursday, friday, saturday, sunday.',
      };
    }
    if (!days.includes(day)) days.push(day);
  }
  return { value: days };
}

function parseBoolean(value, fieldName, defaultValue = false) {
  if (value === undefined || value === null || value === '') return { value: defaultValue };
  if (value === true || value === 'true' || value === 1 || value === '1') return { value: true };
  if (value === false || value === 'false' || value === 0 || value === '0') return { value: false };
  return { error: `${fieldName} must be true or false.` };
}

function parseThreshold(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return { value: defaultValue };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 240) {
    return { error: 'working_hours_threshold_minutes must be an integer between 0 and 240.' };
  }
  return { value: n };
}

function calculateShiftDurations(row) {
  const shiftMinutes = durationMinutes(row.start_time, row.end_time);
  const breakMinutes =
    row.break_start_time && row.break_end_time ? durationMinutes(row.break_start_time, row.break_end_time) : 0;
  const scheduledWorkMinutes = row.exclude_break_from_working_hours
    ? Math.max(shiftMinutes - breakMinutes, 0)
    : shiftMinutes;

  return {
    gross_shift_minutes: shiftMinutes,
    break_duration_minutes: breakMinutes,
    scheduled_work_minutes: scheduledWorkMinutes,
  };
}

function mapShiftRow(row) {
  const durations = calculateShiftDurations(row);
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    start_time: row.start_time,
    end_time: row.end_time,
    break_start_time: row.break_start_time,
    break_end_time: row.break_end_time,
    working_days: Array.isArray(row.working_days) ? row.working_days : [],
    exclude_break_from_working_hours: Boolean(row.exclude_break_from_working_hours),
    working_hours_threshold_minutes: Number(row.working_hours_threshold_minutes ?? 0),
    gross_shift_minutes: durations.gross_shift_minutes,
    gross_shift_hours: Number((durations.gross_shift_minutes / 60).toFixed(2)),
    break_duration_minutes: durations.break_duration_minutes,
    break_duration_hours: Number((durations.break_duration_minutes / 60).toFixed(2)),
    scheduled_work_minutes: durations.scheduled_work_minutes,
    scheduled_work_hours: Number((durations.scheduled_work_minutes / 60).toFixed(2)),
    is_active: Boolean(row.is_active),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
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
  if (!admin.is_active || !admin.company_id) {
    return { error: [403, 'Your account must be active and linked to a company.'] };
  }
  return { admin };
}

function parseSort(query = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'created_at').trim();
  const sortBy = SORT_FIELDS.get(sortByRaw);
  if (!sortBy) {
    return { error: `sort_by must be one of: ${Array.from(SORT_FIELDS.keys()).join(', ')}.` };
  }
  const orderRaw = String(query.sort_order || query.sortOrder || 'desc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(orderRaw)) return { error: 'sort_order must be asc or desc.' };
  return {
    orderBySql: `${sortBy} ${orderRaw.toUpperCase()}, id DESC`,
    sort_by: sortByRaw,
    sort_order: orderRaw,
  };
}

function validateBreakWindow(shiftStart, shiftEnd, breakStart, breakEnd) {
  if ((breakStart && !breakEnd) || (!breakStart && breakEnd)) {
    return 'break_start_time and break_end_time must both be provided together, or both omitted.';
  }
  if (!breakStart || !breakEnd) return null;

  const shiftDuration = durationMinutes(shiftStart, shiftEnd);
  const breakDuration = durationMinutes(breakStart, breakEnd);
  if (breakDuration <= 0) return 'break_end_time must be later than break_start_time.';
  if (breakDuration > shiftDuration) return 'Break duration cannot be greater than shift duration.';
  return null;
}

async function createShift(req, res) {
  const body = req.body || {};
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const companyId = parsePositiveInt(body.company_id ?? auth.admin.company_id);
  if (!companyId || companyId !== Number(auth.admin.company_id)) {
    return sendError(res, 403, 'You can only manage shifts for your own company.');
  }

  const name = String(body.name || body.shift_name || '').trim();
  if (!name) return sendError(res, 400, 'name is required.');
  if (name.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');

  const start = normalizeTime(body.start_time, 'start_time', true);
  if (start.error) return sendError(res, 400, start.error);
  const end = normalizeTime(body.end_time, 'end_time', true);
  if (end.error) return sendError(res, 400, end.error);
  if (durationMinutes(start.value, end.value) <= 0) {
    return sendError(res, 400, 'end_time must be later than start_time.');
  }

  const breakStart = normalizeTime(body.break_start_time, 'break_start_time');
  if (breakStart.error) return sendError(res, 400, breakStart.error);
  const breakEnd = normalizeTime(body.break_end_time, 'break_end_time');
  if (breakEnd.error) return sendError(res, 400, breakEnd.error);
  const breakError = validateBreakWindow(start.value, end.value, breakStart.value, breakEnd.value);
  if (breakError) return sendError(res, 400, breakError);

  const days = parseWorkingDays(body.working_days, true);
  if (days.error) return sendError(res, 400, days.error);
  const excludeBreak = parseBoolean(body.exclude_break_from_working_hours, 'exclude_break_from_working_hours', false);
  if (excludeBreak.error) return sendError(res, 400, excludeBreak.error);
  const threshold = parseThreshold(body.working_hours_threshold_minutes ?? body.threshold_minutes, 0);
  if (threshold.error) return sendError(res, 400, threshold.error);
  const isActive = parseBoolean(body.is_active, 'is_active', true);
  if (isActive.error) return sendError(res, 400, isActive.error);

  try {
    const nowUtc = utcNowForPgTimestamp();
    const result = await pool.query(
      `INSERT INTO shifts (
         company_id, name, start_time, end_time, break_start_time, break_end_time,
         working_days, exclude_break_from_working_hours, working_hours_threshold_minutes,
         is_active, created_at, updated_at
       )
       VALUES ($1, $2, $3::time, $4::time, $5::time, $6::time, $7::jsonb, $8, $9, $10, $11::timestamp, $11::timestamp)
       RETURNING *`,
      [
        companyId,
        name,
        start.value,
        end.value,
        breakStart.value,
        breakEnd.value,
        JSON.stringify(days.value),
        excludeBreak.value,
        threshold.value,
        isActive.value,
        nowUtc,
      ]
    );

    return sendSuccess(res, 201, 'Shift created successfully.', { shift: mapShiftRow(result.rows[0]) });
  } catch (error) {
    if (error?.code === '23505') return sendError(res, 409, 'A shift with this name already exists.');
    console.error('createShift error:', error);
    return sendError(res, 500, 'Something went wrong while creating shift.');
  }
}

async function getShifts(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');

  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);
  const sort = parseSort(req.query);
  if (sort.error) return sendError(res, 400, sort.error);
  const search = String(req.query?.search || '').trim();

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    if (companyId !== Number(auth.admin.company_id)) {
      return sendError(res, 403, 'You can only view shifts for your own company.');
    }

    const values = [companyId];
    let searchClause = '';
    if (search) {
      values.push(`%${search}%`);
      searchClause = `AND name ILIKE $2`;
    }

    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM shifts WHERE company_id = $1 ${searchClause}`, values);
    const result = listPagination.noPagination
      ? await pool.query(
          `SELECT * FROM shifts
           WHERE company_id = $1 ${searchClause}
           ORDER BY ${sort.orderBySql}`,
          values
        )
      : await pool.query(
          `SELECT * FROM shifts
           WHERE company_id = $1 ${searchClause}
           ORDER BY ${sort.orderBySql}
           LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, listPagination.pagination.limit, listPagination.pagination.offset]
        );

    return sendSuccess(res, 200, 'Shifts fetched successfully.', {
      shifts: result.rows.map(mapShiftRow),
      pagination: buildListPaginationMeta(count.rows[0]?.total, listPagination),
      sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    });
  } catch (error) {
    console.error('getShifts error:', error);
    return sendError(res, 500, 'Something went wrong while fetching shifts.');
  }
}

async function getShiftById(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Shift id must be a positive integer.');
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    if (companyId !== Number(auth.admin.company_id)) {
      return sendError(res, 403, 'You can only view shifts for your own company.');
    }

    const result = await pool.query('SELECT * FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (result.rowCount === 0) return sendError(res, 404, 'Shift not found.');
    return sendSuccess(res, 200, 'Shift fetched successfully.', { shift: mapShiftRow(result.rows[0]) });
  } catch (error) {
    console.error('getShiftById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching shift.');
  }
}

async function updateShift(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Shift id must be a positive integer.');

  const body = req.body || {};
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const companyId = parsePositiveInt(body.company_id ?? req.query?.company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');
  if (companyId !== Number(auth.admin.company_id)) {
    return sendError(res, 403, 'You can only update shifts for your own company.');
  }

  const existing = await pool.query('SELECT * FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (existing.rowCount === 0) return sendError(res, 404, 'Shift not found.');
  const current = existing.rows[0];

  const allowedKeys = new Set([
    'company_id',
    'name',
    'shift_name',
    'start_time',
    'end_time',
    'break_start_time',
    'break_end_time',
    'working_days',
    'exclude_break_from_working_hours',
    'working_hours_threshold_minutes',
    'threshold_minutes',
    'is_active',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return sendError(res, 400, `Unknown field "${key}".`);
  }

  const updates = [];
  const values = [];
  let idx = 1;
  const add = (column, value, cast = '') => {
    updates.push(`${column} = $${idx++}${cast}`);
    values.push(value);
  };

  const nextStart = Object.prototype.hasOwnProperty.call(body, 'start_time')
    ? normalizeTime(body.start_time, 'start_time', true)
    : { value: String(current.start_time).slice(0, 8) };
  if (nextStart.error) return sendError(res, 400, nextStart.error);
  const nextEnd = Object.prototype.hasOwnProperty.call(body, 'end_time')
    ? normalizeTime(body.end_time, 'end_time', true)
    : { value: String(current.end_time).slice(0, 8) };
  if (nextEnd.error) return sendError(res, 400, nextEnd.error);

  const nextBreakStart = Object.prototype.hasOwnProperty.call(body, 'break_start_time')
    ? normalizeTime(body.break_start_time, 'break_start_time')
    : { value: current.break_start_time ? String(current.break_start_time).slice(0, 8) : null };
  if (nextBreakStart.error) return sendError(res, 400, nextBreakStart.error);
  const nextBreakEnd = Object.prototype.hasOwnProperty.call(body, 'break_end_time')
    ? normalizeTime(body.break_end_time, 'break_end_time')
    : { value: current.break_end_time ? String(current.break_end_time).slice(0, 8) : null };
  if (nextBreakEnd.error) return sendError(res, 400, nextBreakEnd.error);

  if (durationMinutes(nextStart.value, nextEnd.value) <= 0) {
    return sendError(res, 400, 'end_time must be later than start_time.');
  }
  const breakError = validateBreakWindow(nextStart.value, nextEnd.value, nextBreakStart.value, nextBreakEnd.value);
  if (breakError) return sendError(res, 400, breakError);

  if (Object.prototype.hasOwnProperty.call(body, 'name') || Object.prototype.hasOwnProperty.call(body, 'shift_name')) {
    const name = String(body.name ?? body.shift_name ?? '').trim();
    if (!name) return sendError(res, 400, 'name cannot be empty.');
    if (name.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');
    add('name', name);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'start_time')) add('start_time', nextStart.value, '::time');
  if (Object.prototype.hasOwnProperty.call(body, 'end_time')) add('end_time', nextEnd.value, '::time');
  if (Object.prototype.hasOwnProperty.call(body, 'break_start_time')) add('break_start_time', nextBreakStart.value, '::time');
  if (Object.prototype.hasOwnProperty.call(body, 'break_end_time')) add('break_end_time', nextBreakEnd.value, '::time');
  if (Object.prototype.hasOwnProperty.call(body, 'working_days')) {
    const days = parseWorkingDays(body.working_days, true);
    if (days.error) return sendError(res, 400, days.error);
    add('working_days', JSON.stringify(days.value), '::jsonb');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'exclude_break_from_working_hours')) {
    const parsed = parseBoolean(body.exclude_break_from_working_hours, 'exclude_break_from_working_hours');
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('exclude_break_from_working_hours', parsed.value);
  }
  if (
    Object.prototype.hasOwnProperty.call(body, 'working_hours_threshold_minutes') ||
    Object.prototype.hasOwnProperty.call(body, 'threshold_minutes')
  ) {
    const parsed = parseThreshold(body.working_hours_threshold_minutes ?? body.threshold_minutes);
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('working_hours_threshold_minutes', parsed.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    const parsed = parseBoolean(body.is_active, 'is_active');
    if (parsed.error) return sendError(res, 400, parsed.error);
    add('is_active', parsed.value);
  }

  if (updates.length === 0) return sendError(res, 400, 'Provide at least one field to update besides company_id.');

  try {
    const nowUtc = utcNowForPgTimestamp();
    values.push(nowUtc, id, companyId);
    const updatedAtPos = idx++;
    const idPos = idx++;
    const companyPos = idx++;
    const result = await pool.query(
      `UPDATE shifts
       SET ${updates.join(', ')}, updated_at = $${updatedAtPos}::timestamp
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );

    return sendSuccess(res, 200, 'Shift updated successfully.', { shift: mapShiftRow(result.rows[0]) });
  } catch (error) {
    if (error?.code === '23505') return sendError(res, 409, 'A shift with this name already exists.');
    console.error('updateShift error:', error);
    return sendError(res, 500, 'Something went wrong while updating shift.');
  }
}

async function deleteShift(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Shift id must be a positive integer.');
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
    if (companyId !== Number(auth.admin.company_id)) {
      return sendError(res, 403, 'You can only delete shifts for your own company.');
    }

    const assigned = await pool.query(
      `SELECT COUNT(*)::int AS total FROM employee_job_details WHERE company_id = $1 AND shift_id = $2`,
      [companyId, id]
    );
    if (Number(assigned.rows[0]?.total || 0) > 0) {
      return sendError(res, 409, 'Cannot delete a shift assigned to employees.');
    }

    const result = await pool.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2 RETURNING *', [
      id,
      companyId,
    ]);
    if (result.rowCount === 0) return sendError(res, 404, 'Shift not found.');
    return sendSuccess(res, 200, 'Shift deleted successfully.', { shift: mapShiftRow(result.rows[0]) });
  } catch (error) {
    console.error('deleteShift error:', error);
    return sendError(res, 500, 'Something went wrong while deleting shift.');
  }
}

module.exports = {
  createShift,
  getShifts,
  getShiftById,
  updateShift,
  deleteShift,
};
