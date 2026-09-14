const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta, parseBooleanQuery } = require('./pagination.service');
const { toUtcIsoString, parseRequiredDateInput, parseOptionalDateInput } = require('../utils/dateTime');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_REGEX = /^\d{4}-\d{2}$/;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_HOLIDAY_COLOR = '#3788D8';

/** Read UTC holiday bounds as text from PostgreSQL — no Node Date parsing. */
const HOLIDAY_SELECT = `h.id,
  h.company_id,
  h.holiday_type_id,
  h.name,
  (h.start_date AT TIME ZONE 'UTC')::date::text AS start_date_key,
  (h.end_date AT TIME ZONE 'UTC')::date::text AS end_date_key,
  to_char(h.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T00:00:00.000"') || 'Z' AS start_date,
  to_char(h.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T00:00:00.000"') || 'Z' AS end_date,
  h.is_mandatory,
  h.color,
  h.created_at,
  h.updated_at,
  ht.name AS holiday_type_name,
  ht.description AS holiday_type_description`;

/** YYYY-MM-DD → PostgreSQL UTC literal (explicit +00, no timezone conversion). */
function utcDateKeyToPgLiteral(dateKey) {
  if (!DATE_REGEX.test(dateKey)) return null;
  return `${dateKey} 00:00:00+00`;
}

/** YYYY-MM-DD → API UTC string (string concat only). */
function utcDateKeyToApiValue(dateKey) {
  if (!DATE_REGEX.test(dateKey)) return null;
  return `${dateKey}T00:00:00.000Z`;
}

function addOneUtcDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function eachUtcDateKeyInRange(startKey, endKey) {
  if (!DATE_REGEX.test(startKey) || !DATE_REGEX.test(endKey) || startKey > endKey) return [];
  const dates = [];
  let cursor = startKey;
  while (true) {
    dates.push(cursor);
    if (cursor === endKey) break;
    cursor = addOneUtcDateKey(cursor);
  }
  return dates;
}

const HOLIDAY_FROM = `FROM holidays h
  INNER JOIN holiday_types ht ON ht.id = h.holiday_type_id AND ht.company_id = h.company_id`;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseDateString(value, fieldName) {
  const parsed = parseRequiredDateInput(value, fieldName);
  if (parsed.error) return { error: parsed.error };
  return { value: parsed.value, pg_utc: utcDateKeyToPgLiteral(parsed.value) };
}

function parseOptionalDateString(value, fieldName) {
  const parsed = parseOptionalDateInput(value, fieldName);
  if (parsed.error) return { error: parsed.error };
  if (!parsed.value) return { value: null };
  return { value: parsed.value, pg_utc: utcDateKeyToPgLiteral(parsed.value) };
}

function parseBooleanField(value, fieldName, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue };
  }
  if (value === true || value === 'true' || value === 1 || value === '1') return { value: true };
  if (value === false || value === 'false' || value === 0 || value === '0') return { value: false };
  return { error: `${fieldName} must be true or false.` };
}

function normalizeHolidayColor(value) {
  if (value === undefined || value === null || value === '') {
    return { value: DEFAULT_HOLIDAY_COLOR };
  }
  const color = String(value).trim().toUpperCase();
  if (!HEX_COLOR_REGEX.test(color)) {
    return { error: 'color must be a hex value like #3788D8.' };
  }
  return { value: color };
}

function resolveDateFormat(startDate, endDate) {
  if (startDate === endDate) return 'single';
  return 'range';
}

function mapHolidayTypeRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    description: row.description ?? null,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function mapHolidayRow(row) {
  const startDateKey = row.start_date_key;
  const endDateKey = row.end_date_key;
  const parsedColor = normalizeHolidayColor(row.color);
  const color = parsedColor.error ? DEFAULT_HOLIDAY_COLOR : parsedColor.value;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    holiday_type_id: Number(row.holiday_type_id),
    holiday_type: {
      id: Number(row.holiday_type_id),
      name: row.holiday_type_name,
      description: row.holiday_type_description ?? null,
    },
    date_format: resolveDateFormat(startDateKey, endDateKey),
    start_date: row.start_date,
    end_date: row.end_date,
    is_mandatory: row.is_mandatory === true,
    color,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function buildCalendarDays(holidays, monthFilter) {
  const daysMap = new Map();

  for (const holiday of holidays) {
    const startKey = holiday.start_date?.slice(0, 10);
    const endKey = holiday.end_date?.slice(0, 10);
    for (const dateKey of eachUtcDateKeyInRange(startKey, endKey)) {
      if (monthFilter && !dateKey.startsWith(monthFilter)) continue;
      if (!daysMap.has(dateKey)) daysMap.set(dateKey, []);
      daysMap.get(dateKey).push({
        id: holiday.id,
        name: holiday.name,
        holiday_type_id: holiday.holiday_type_id,
        holiday_type_name: holiday.holiday_type?.name ?? null,
        is_mandatory: holiday.is_mandatory,
        color: holiday.color,
        start_date: holiday.start_date,
        end_date: holiday.end_date,
        date_format: holiday.date_format,
      });
    }
  }

  const calendar_days = Array.from(daysMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayHolidays]) => ({
      date,
      date_utc: utcDateKeyToApiValue(date),
      holidays: dayHolidays,
    }));

  return calendar_days;
}

async function getAuthenticatedCompanyAdmin(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
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

async function getAuthenticatedUser(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };
  const user = result.rows[0];
  if (!user.is_active) return { error: [403, 'Your account is inactive. Please contact support.'] };
  return { user };
}

async function assertHolidayTypeBelongsToCompany(holidayTypeId, companyId) {
  const result = await pool.query(
    `SELECT id FROM holiday_types WHERE id = $1 AND company_id = $2`,
    [holidayTypeId, companyId]
  );
  return result.rowCount > 0;
}

/**
 * Duplicate = same company, same name (case-insensitive), overlapping date range.
 * excludeHolidayId skips the row being edited.
 */
async function findDuplicateHoliday({
  companyId,
  name,
  startDateKey,
  endDateKey,
  excludeHolidayId = null,
}) {
  const values = [companyId, name, utcDateKeyToPgLiteral(startDateKey), utcDateKeyToPgLiteral(endDateKey)];
  let excludeSql = '';
  if (excludeHolidayId) {
    values.push(excludeHolidayId);
    excludeSql = ` AND h.id <> $${values.length}`;
  }

  const result = await pool.query(
    `SELECT h.id, h.name,
            (h.start_date AT TIME ZONE 'UTC')::date::text AS start_date_key,
            (h.end_date AT TIME ZONE 'UTC')::date::text AS end_date_key
     FROM holidays h
     WHERE h.company_id = $1
       AND LOWER(TRIM(h.name)) = LOWER(TRIM($2))
       AND h.start_date <= $4::timestamptz
       AND h.end_date >= $3::timestamptz
       ${excludeSql}
     LIMIT 1`,
    values
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function fetchHolidayById(holidayId, companyId) {
  const result = await pool.query(
    `SELECT ${HOLIDAY_SELECT}
     ${HOLIDAY_FROM}
     WHERE h.id = $1 AND h.company_id = $2`,
    [holidayId, companyId]
  );
  return result.rows[0] || null;
}

async function fetchHolidayTypeById(typeId, companyId) {
  const result = await pool.query(
    `SELECT * FROM holiday_types WHERE id = $1 AND company_id = $2`,
    [typeId, companyId]
  );
  return result.rows[0] || null;
}

function parseHolidayDates(body) {
  const dateFormat = String(body.date_format || '').trim().toLowerCase();
  const start = parseDateString(body.start_date, 'start_date');
  if (start.error) return { error: start.error };

  if (!dateFormat || dateFormat === 'single') {
    return {
      start_date_pg: start.pg_utc,
      end_date_pg: start.pg_utc,
      start_date_key: start.value,
      end_date_key: start.value,
      date_format: 'single',
    };
  }
  if (dateFormat !== 'range') {
    return { error: 'date_format must be "single" or "range".' };
  }

  const end = parseDateString(body.end_date, 'end_date');
  if (end.error) return { error: end.error };
  if (end.value < start.value) {
    return { error: 'end_date must be on or after start_date.' };
  }
  return {
    start_date_pg: start.pg_utc,
    end_date_pg: end.pg_utc,
    start_date_key: start.value,
    end_date_key: end.value,
    date_format: 'range',
  };
}

function parseMonthFilter(query = {}) {
  const month = String(query.month || '').trim();
  if (!month) return { value: null };
  if (!MONTH_REGEX.test(month)) return { error: 'month must be in YYYY-MM format.' };
  return { value: month };
}

async function createHolidayType(companyId, body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: [400, 'name is required.'] };
  if (name.length > 120) return { error: [400, 'name must be at most 120 characters.'] };

  const description =
    body.description === undefined || body.description === null
      ? null
      : String(body.description).trim() || null;

  try {
    const insert = await pool.query(
      `INSERT INTO holiday_types (company_id, name, description, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [companyId, name, description]
    );
    return { holiday_type: mapHolidayTypeRow(insert.rows[0]) };
  } catch (error) {
    if (error?.code === '23505') {
      return { error: [409, 'A holiday type with this name already exists for this company.'] };
    }
    throw error;
  }
}

async function getHolidayTypes(companyId, query) {
  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM holiday_types
     WHERE company_id = $1
       AND (
         $2::text = ''
         OR name ILIKE $2
         OR COALESCE(description, '') ILIKE $2
       )`,
    [companyId, hasSearch ? searchLike : '']
  );

  const result = listPagination.noPagination
    ? await pool.query(
        `SELECT * FROM holiday_types
         WHERE company_id = $1
           AND (
             $2::text = ''
             OR name ILIKE $2
             OR COALESCE(description, '') ILIKE $2
           )
         ORDER BY name ASC`,
        [companyId, hasSearch ? searchLike : '']
      )
    : await pool.query(
        `SELECT * FROM holiday_types
         WHERE company_id = $1
           AND (
             $2::text = ''
             OR name ILIKE $2
             OR COALESCE(description, '') ILIKE $2
           )
         ORDER BY name ASC
         LIMIT $3 OFFSET $4`,
        [
          companyId,
          hasSearch ? searchLike : '',
          listPagination.pagination.limit,
          listPagination.pagination.offset,
        ]
      );

  return {
    holiday_types: result.rows.map(mapHolidayTypeRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getHolidayTypeById(typeId, companyId) {
  const row = await fetchHolidayTypeById(typeId, companyId);
  if (!row) return { error: [404, 'Holiday type not found.'] };
  return { holiday_type: mapHolidayTypeRow(row) };
}

async function updateHolidayType(typeId, companyId, body) {
  const allowedKeys = new Set(['name', 'description']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
  if (!hasName && !hasDescription) {
    return { error: [400, 'Provide name and/or description to update.'] };
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (hasName) {
    const name = String(body.name || '').trim();
    if (!name) return { error: [400, 'name cannot be empty.'] };
    if (name.length > 120) return { error: [400, 'name must be at most 120 characters.'] };
    updates.push(`name = $${idx++}`);
    values.push(name);
  }
  if (hasDescription) {
    const description =
      body.description === null ? null : String(body.description || '').trim() || null;
    updates.push(`description = $${idx++}`);
    values.push(description);
  }

  values.push(typeId, companyId);
  const idPos = idx++;
  const companyPos = idx++;

  try {
    const updated = await pool.query(
      `UPDATE holiday_types
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return { error: [404, 'Holiday type not found.'] };
    return { holiday_type: mapHolidayTypeRow(updated.rows[0]) };
  } catch (error) {
    if (error?.code === '23505') {
      return { error: [409, 'A holiday type with this name already exists for this company.'] };
    }
    throw error;
  }
}

async function deleteHolidayType(typeId, companyId) {
  try {
    const deleted = await pool.query(
      `DELETE FROM holiday_types WHERE id = $1 AND company_id = $2 RETURNING *`,
      [typeId, companyId]
    );
    if (deleted.rowCount === 0) return { error: [404, 'Holiday type not found.'] };
    return { holiday_type: mapHolidayTypeRow(deleted.rows[0]) };
  } catch (error) {
    if (error?.code === '23503') {
      return {
        error: [
          409,
          'This holiday type is linked to one or more holidays. Reassign or delete those holidays first.',
        ],
      };
    }
    throw error;
  }
}

async function createHoliday(companyId, body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: [400, 'name is required.'] };
  if (name.length > 200) return { error: [400, 'name must be at most 200 characters.'] };

  const holidayTypeId = parsePositiveInt(body.holiday_type_id);
  if (!holidayTypeId) {
    return { error: [400, 'holiday_type_id is required and must be a positive integer.'] };
  }

  const dates = parseHolidayDates(body);
  if (dates.error) return { error: [400, dates.error] };

  const mandatory = parseBooleanField(body.is_mandatory, 'is_mandatory', true);
  if (mandatory.error) return { error: [400, mandatory.error] };

  const color = normalizeHolidayColor(body.color);
  if (color.error) return { error: [400, color.error] };

  const typeOk = await assertHolidayTypeBelongsToCompany(holidayTypeId, companyId);
  if (!typeOk) return { error: [404, 'Holiday type not found for this company.'] };

  const duplicate = await findDuplicateHoliday({
    companyId,
    name,
    startDateKey: dates.start_date_key,
    endDateKey: dates.end_date_key,
  });
  if (duplicate) {
    return {
      error: [409, 'A holiday with the same name and date already exists.'],
    };
  }

  try {
    const insert = await pool.query(
      `INSERT INTO holidays (
         company_id, holiday_type_id, name, start_date, end_date, is_mandatory, color, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, NOW(), NOW())
       RETURNING id`,
      [
        companyId,
        holidayTypeId,
        name,
        dates.start_date_pg,
        dates.end_date_pg,
        mandatory.value,
        color.value,
      ]
    );
    const row = await fetchHolidayById(insert.rows[0].id, companyId);
    return { holiday: mapHolidayRow(row) };
  } catch (error) {
    if (error?.code === '23503') {
      return { error: [400, 'holiday_type_id does not reference a valid holiday type.'] };
    }
    throw error;
  }
}

async function getHolidays(companyId, query) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const monthFilter = parseMonthFilter(query);
  if (monthFilter.error) return { error: [400, monthFilter.error] };

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;

  const values = [companyId];
  let whereSql = 'WHERE h.company_id = $1';
  if (monthFilter.value) {
    const [year, month] = monthFilter.value.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const rangeStart = utcDateKeyToPgLiteral(`${monthFilter.value}-01`);
    const rangeEnd = utcDateKeyToPgLiteral(
      `${monthFilter.value}-${String(lastDay).padStart(2, '0')}`
    );
    values.push(rangeStart, rangeEnd);
    whereSql += ` AND h.start_date <= $3::timestamptz AND h.end_date >= $2::timestamptz`;
  }

  const searchParamIndex = values.length + 1;
  if (hasSearch) {
    values.push(searchLike);
    whereSql += ` AND (
      h.name ILIKE $${searchParamIndex}
      OR ht.name ILIKE $${searchParamIndex}
      OR COALESCE(ht.description, '') ILIKE $${searchParamIndex}
    )`;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM holidays h
     INNER JOIN holiday_types ht ON ht.id = h.holiday_type_id AND ht.company_id = h.company_id
     ${whereSql}`,
    values
  );

  const listValues = [...values];
  let limitSql = 'ORDER BY h.start_date ASC, h.id ASC';
  if (!listPagination.noPagination) {
    listValues.push(listPagination.pagination.limit, listPagination.pagination.offset);
    limitSql += ` LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`;
  }

  const result = await pool.query(
    `SELECT ${HOLIDAY_SELECT}
     ${HOLIDAY_FROM}
     ${whereSql}
     ${limitSql}`,
    listValues
  );

  return {
    holidays: result.rows.map(mapHolidayRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getHolidayById(holidayId, companyId) {
  const row = await fetchHolidayById(holidayId, companyId);
  if (!row) return { error: [404, 'Holiday not found.'] };
  return { holiday: mapHolidayRow(row) };
}

async function updateHoliday(holidayId, companyId, body) {
  const existing = await fetchHolidayById(holidayId, companyId);
  if (!existing) return { error: [404, 'Holiday not found.'] };

  const allowedKeys = new Set([
    'name',
    'holiday_type_id',
    'date_format',
    'start_date',
    'end_date',
    'is_mandatory',
    'color',
  ]);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }

  const bodyKeys = Object.keys(body || {});
  if (bodyKeys.length === 0 || !bodyKeys.some((key) => allowedKeys.has(key))) {
    return { error: [400, 'Provide at least one field to update.'] };
  }

  const updates = [];
  const values = [];
  let idx = 1;

  let nextName = existing.name;
  let nextStartKey = existing.start_date_key;
  let nextEndKey = existing.end_date_key;

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim();
    if (!name) return { error: [400, 'name cannot be empty.'] };
    if (name.length > 200) return { error: [400, 'name must be at most 200 characters.'] };
    nextName = name;
    updates.push(`name = $${idx++}`);
    values.push(name);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'holiday_type_id')) {
    const holidayTypeId = parsePositiveInt(body.holiday_type_id);
    if (!holidayTypeId) {
      return { error: [400, 'holiday_type_id must be a positive integer.'] };
    }
    const typeOk = await assertHolidayTypeBelongsToCompany(holidayTypeId, companyId);
    if (!typeOk) return { error: [404, 'Holiday type not found for this company.'] };
    updates.push(`holiday_type_id = $${idx++}`);
    values.push(holidayTypeId);
  }

  const hasDateFields =
    Object.prototype.hasOwnProperty.call(body, 'date_format') ||
    Object.prototype.hasOwnProperty.call(body, 'start_date') ||
    Object.prototype.hasOwnProperty.call(body, 'end_date');

  if (hasDateFields) {
    const merged = {
      date_format: Object.prototype.hasOwnProperty.call(body, 'date_format')
        ? body.date_format
        : resolveDateFormat(existing.start_date_key, existing.end_date_key),
      start_date: Object.prototype.hasOwnProperty.call(body, 'start_date')
        ? body.start_date
        : existing.start_date_key,
      end_date: Object.prototype.hasOwnProperty.call(body, 'end_date')
        ? body.end_date
        : existing.end_date_key,
    };
    const dates = parseHolidayDates(merged);
    if (dates.error) return { error: [400, dates.error] };
    nextStartKey = dates.start_date_key;
    nextEndKey = dates.end_date_key;
    updates.push(`start_date = $${idx++}::timestamptz`);
    values.push(dates.start_date_pg);
    updates.push(`end_date = $${idx++}::timestamptz`);
    values.push(dates.end_date_pg);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'is_mandatory')) {
    const mandatory = parseBooleanField(body.is_mandatory, 'is_mandatory');
    if (mandatory.error) return { error: [400, mandatory.error] };
    updates.push(`is_mandatory = $${idx++}`);
    values.push(mandatory.value);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'color')) {
    const color = normalizeHolidayColor(body.color);
    if (color.error) return { error: [400, color.error] };
    updates.push(`color = $${idx++}`);
    values.push(color.value);
  }

  const duplicate = await findDuplicateHoliday({
    companyId,
    name: nextName,
    startDateKey: nextStartKey,
    endDateKey: nextEndKey,
    excludeHolidayId: holidayId,
  });
  if (duplicate) {
    return {
      error: [409, 'A holiday with the same name and date already exists.'],
    };
  }

  values.push(holidayId, companyId);
  const idPos = idx++;
  const companyPos = idx++;

  const updated = await pool.query(
    `UPDATE holidays
     SET ${updates.join(', ')}, updated_at = NOW()
     WHERE id = $${idPos} AND company_id = $${companyPos}
     RETURNING id`,
    values
  );
  if (updated.rowCount === 0) return { error: [404, 'Holiday not found.'] };

  const row = await fetchHolidayById(updated.rows[0].id, companyId);
  return { holiday: mapHolidayRow(row) };
}

async function deleteHoliday(holidayId, companyId) {
  const deleted = await pool.query(
    `DELETE FROM holidays WHERE id = $1 AND company_id = $2 RETURNING id`,
    [holidayId, companyId]
  );
  if (deleted.rowCount === 0) return { error: [404, 'Holiday not found.'] };
  return { id: Number(deleted.rows[0].id) };
}

/**
 * Company holidays for a month — same overlap query as GET /holidays?month=YYYY-MM.
 * Returns a date map for attendance/calendar integrations without changing holiday APIs.
 */
async function getCompanyHolidaysForMonth(companyId, month, options = {}) {
  if (!companyId) {
    return { holidays: [], holidaysByDate: new Map() };
  }

  const monthFilter = month ? parseMonthFilter({ month: String(month).trim() }) : { value: null };
  if (monthFilter.error) {
    return { error: monthFilter.error };
  }

  const values = [Number(companyId)];
  let whereSql = 'WHERE h.company_id = $1';
  if (options.mandatoryOnly === true) {
    whereSql += ' AND h.is_mandatory = true';
  }

  if (monthFilter.value) {
    const [year, monthNumber] = monthFilter.value.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const rangeStart = utcDateKeyToPgLiteral(`${monthFilter.value}-01`);
    const rangeEnd = utcDateKeyToPgLiteral(
      `${monthFilter.value}-${String(lastDay).padStart(2, '0')}`
    );
    values.push(rangeStart, rangeEnd);
    whereSql += ` AND h.start_date <= $3::timestamptz AND h.end_date >= $2::timestamptz`;
  }

  const result = await pool.query(
    `SELECT ${HOLIDAY_SELECT}
     ${HOLIDAY_FROM}
     ${whereSql}
     ORDER BY h.start_date ASC, h.id ASC`,
    values
  );

  const holidays = result.rows.map(mapHolidayRow);
  const holidaysByDate = new Map();

  for (const holiday of holidays) {
    const startKey = holiday.start_date?.slice(0, 10);
    const endKey = holiday.end_date?.slice(0, 10);
    for (const dateKey of eachUtcDateKeyInRange(startKey, endKey)) {
      if (monthFilter.value && !dateKey.startsWith(monthFilter.value)) continue;
      const entry = {
        id: holiday.id,
        name: holiday.name,
        holiday_type_id: holiday.holiday_type_id,
        holiday_type: holiday.holiday_type,
        is_mandatory: holiday.is_mandatory,
        color: holiday.color,
        date_format: holiday.date_format,
        start_date: holiday.start_date,
        end_date: holiday.end_date,
      };
      if (!holidaysByDate.has(dateKey)) holidaysByDate.set(dateKey, []);
      holidaysByDate.get(dateKey).push(entry);
    }
  }

  return { holidays, holidaysByDate };
}

async function getCompanyHolidayDateKeysForRange(companyId, fromDateKey, toDateKey, db = pool) {
  if (!DATE_REGEX.test(fromDateKey) || !DATE_REGEX.test(toDateKey) || fromDateKey > toDateKey) {
    return new Set();
  }

  const rangeStart = utcDateKeyToPgLiteral(fromDateKey);
  const rangeEnd = utcDateKeyToPgLiteral(toDateKey);
  const result = await db.query(
    `SELECT (h.start_date AT TIME ZONE 'UTC')::date::text AS start_date_key,
            (h.end_date AT TIME ZONE 'UTC')::date::text AS end_date_key
     FROM holidays h
     WHERE h.company_id = $1
       AND h.start_date <= $3::timestamptz
       AND h.end_date >= $2::timestamptz`,
    [companyId, rangeStart, rangeEnd]
  );

  const holidayDateKeys = new Set();
  for (const row of result.rows) {
    for (const dateKey of eachUtcDateKeyInRange(row.start_date_key, row.end_date_key)) {
      if (dateKey >= fromDateKey && dateKey <= toDateKey) {
        holidayDateKeys.add(dateKey);
      }
    }
  }
  return holidayDateKeys;
}

async function getHolidayCalendar(authUser, query) {
  const userResult = await getAuthenticatedUser(authUser);
  if (userResult.error) return { error: userResult.error };

  const { user } = userResult;
  if (!user.company_id) {
    return { error: [403, 'Your account is not linked to a company.'] };
  }

  const companyViewRaw = parseBooleanQuery(query.company, false);
  if (companyViewRaw === null) {
    return { error: [400, 'company must be true or false.'] };
  }

  const monthFilter = parseMonthFilter(query);
  if (monthFilter.error) return { error: [400, monthFilter.error] };

  const includeAll = companyViewRaw === true;
  if (includeAll && user.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can view all company holidays.'] };
  }

  const companyId = Number(user.company_id);
  const values = [companyId];
  let whereSql = 'WHERE h.company_id = $1';
  if (!includeAll) {
    whereSql += ' AND h.is_mandatory = true';
  }

  if (monthFilter.value) {
    const [year, month] = monthFilter.value.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const rangeStart = utcDateKeyToPgLiteral(`${monthFilter.value}-01`);
    const rangeEnd = utcDateKeyToPgLiteral(
      `${monthFilter.value}-${String(lastDay).padStart(2, '0')}`
    );
    values.push(rangeStart, rangeEnd);
    whereSql += ` AND h.start_date <= $3::timestamptz AND h.end_date >= $2::timestamptz`;
  }

  const result = await pool.query(
    `SELECT ${HOLIDAY_SELECT}
     ${HOLIDAY_FROM}
     ${whereSql}
     ORDER BY h.start_date ASC, h.id ASC`,
    values
  );

  const holidays = result.rows.map(mapHolidayRow);
  const calendar_days = buildCalendarDays(holidays, monthFilter.value);

  return {
    company_id: companyId,
    view: includeAll ? 'company_admin' : 'employee',
    month: monthFilter.value,
    holidays,
    calendar_days,
  };
}

module.exports = {
  parsePositiveInt,
  parseOptionalDateString,
  getAuthenticatedCompanyAdmin,
  createHolidayType,
  getHolidayTypes,
  getHolidayTypeById,
  updateHolidayType,
  deleteHolidayType,
  createHoliday,
  getHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
  getHolidayCalendar,
  getCompanyHolidaysForMonth,
  getCompanyHolidayDateKeysForRange,
};
