
function parseUtcDateTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const withT = s.includes(' ') ? s.replace(' ', 'T') : s;
  const d = new Date(`${withT}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}


function dateToPgUtcTimestamp(value) {
  const date = value instanceof Date ? value : parseUtcDateTime(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace('T', ' ').replace('Z', '');
}


function utcNowForPgTimestamp() {
  return dateToPgUtcTimestamp(new Date());
}


function pgTimestampDateToUtcIso(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const y = value.getFullYear();
  const mo = value.getMonth();
  const d = value.getDate();
  const h = value.getHours();
  const mi = value.getMinutes();
  const s = value.getSeconds();
  const ms = value.getMilliseconds();
  return new Date(Date.UTC(y, mo, d, h, mi, s, ms)).toISOString();
}


function toUtcIsoString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    return pgTimestampDateToUtcIso(value);
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  const withT = s.includes(' ') ? s.replace(' ', 'T') : s;
  const d = new Date(`${withT}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Inclusive calendar day count between two YYYY-MM-DD keys (same day = 1). */
function inclusiveCalendarDays(fromDateKey, toDateKey) {
  if (!fromDateKey || !toDateKey) return null;
  const [fy, fm, fd] = String(fromDateKey).split('-').map(Number);
  const [ty, tm, td] = String(toDateKey).split('-').map(Number);
  if (![fy, fm, fd, ty, tm, td].every((n) => Number.isFinite(n))) return null;
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  if (toMs < fromMs) return null;
  return Math.round((toMs - fromMs) / 86400000) + 1;
}

// Normalize a PostgreSQL DATE / date string to YYYY-MM-DD for map lookups.

function toDateKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const displayParsed = parseDisplayDateToYmd(value);
    if (displayParsed) return displayParsed;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// UTC calendar date key (YYYY-MM-DD) from TIMESTAMPTZ / ISO / DATE values.

function toUtcDateKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/** UTC midnight instant for a calendar date key, e.g. 2024-04-10 → 2024-04-10T00:00:00.000Z */
function utcDateKeyToIso(dateKey) {
  const key = toUtcDateKey(dateKey);
  return key ? `${key}T00:00:00.000Z` : null;
}

function wallClockMinutesInTimezone(value, timeZone) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const tz = String(timeZone || '').trim() || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}
//API UTC timestamp without timezone suffix (wall clock = UTC).
function toUtcTimestampString(value) {
  const pg = dateToPgUtcTimestamp(value);
  return pg ? pg.replace(' ', 'T') : null;
}

// Normalize API / DB / Date values to PostgreSQL TIMESTAMP WITHOUT TIME ZONE (UTC wall clock).

function toPgUtcTimestamp(value, { fromDatabase = false } = {}) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) {
    if (fromDatabase) {
      const iso = pgTimestampDateToUtcIso(value);
      return iso ? dateToPgUtcTimestamp(iso) : null;
    }
    return dateToPgUtcTimestamp(value);
  }

  const iso = toUtcIsoString(value);
  if (!iso) return null;
  return dateToPgUtcTimestamp(iso);
}


function normalizeTimeHms(time) {
  if (time === undefined || time === null || time === '') return null;
  const trimmed = String(time).trim();
  if (/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.test(trimmed)) return trimmed;
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmed)) return `${trimmed}:00`;
  return null;
}

function extractZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}


 // Convert a local calendar date + time in an IANA timezone to a true UTC instant.

function localDateAndTimeToUtcInstant(dateYmd, time, timeZone) {
  const normalizedTime = normalizeTimeHms(time);
  const dateKey = toDateKey(dateYmd);
  if (!dateKey || !normalizedTime) return null;

  const tz = String(timeZone || '').trim() || 'UTC';
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute, second = 0] = normalizedTime.split(':').map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = extractZonedParts(new Date(utcMs), tz);
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diffMs = targetMs - actualMs;
    if (diffMs === 0) break;
    utcMs += diffMs;
  }

  const result = new Date(utcMs);
  return Number.isNaN(result.getTime()) ? null : result;
}

function toUtcDate(value) {
  const iso = toUtcIsoString(value);
  if (!iso) return null;
  const date = parseUtcDateTime(iso);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function minutesFromPgTime(value) {
  const normalized = normalizeTimeHms(value);
  if (!normalized) return null;
  const [hours, minutes] = normalized.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * PostgreSQL TIME on shifts/locations is stored as UTC hour digits (picker local → UTC HH:mm).
 * Convert to company-local minutes so late checks match the shift times shown in the UI.
 * @param {string|null|undefined} value
 * @param {string|null|undefined} timeZone
 * @returns {number|null}
 */
function shiftTimeToCompanyLocalMinutes(value, timeZone) {
  const normalized = normalizeTimeHms(value);
  if (!normalized) return null;

  const instant = parseUtcDateTime(`1970-01-01T${normalized}`);
  if (!instant) return minutesFromPgTime(value);

  const minutes = wallClockMinutesInTimezone(instant, timeZone || 'UTC');
  return minutes === null ? minutesFromPgTime(value) : minutes;
}

const DATE_YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DISPLAY_DATE_REGEX = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;
const DATE_INPUT_FORMAT_HINT = 'YYYY-MM-DD or DD MMM YYYY (e.g. 31 May 1906)';
const PAYABLE_DEFAULT_LOCAL_TIME = '17:00:00';

const MONTH_NAME_TO_NUM = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function isValidCalendarParts(year, month, day) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function toYmdString(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse en-GB display dates such as "31 May 1906" to YYYY-MM-DD. */
function parseDisplayDateToYmd(value) {
  const match = String(value || '').trim().match(DISPLAY_DATE_REGEX);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTH_NAME_TO_NUM[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!month || !isValidCalendarParts(year, month, day)) return null;
  return toYmdString(year, month, day);
}


 //Normalize API date input to YYYY-MM-DD.
 // Accepts ISO calendar dates and en-GB display dates (e.g. "31 May 1906").
 
function normalizeDateInput(value, { fieldName = 'date', allowEmpty = true } = {}) {
  if (value === undefined || value === null || value === '') {
    return allowEmpty
      ? { value: null, error: null }
      : { value: null, error: `${fieldName} is required.` };
  }

  const text = String(value).trim();
  if (!text) {
    return allowEmpty
      ? { value: null, error: null }
      : { value: null, error: `${fieldName} is required.` };
  }

  if (DATE_YMD_REGEX.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    if (!isValidCalendarParts(year, month, day)) {
      return { value: null, error: `${fieldName} is not a valid calendar date.` };
    }
    return { value: text, error: null };
  }

  const displayParsed = parseDisplayDateToYmd(text);
  if (displayParsed) {
    return { value: displayParsed, error: null };
  }

  return {
    value: null,
    error: `${fieldName} must be ${DATE_INPUT_FORMAT_HINT}.`,
  };
}

function parseRequiredDateInput(raw, fieldName = 'date') {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: `${fieldName} is required.` };
  }
  const normalized = normalizeDateInput(raw, { fieldName, allowEmpty: false });
  if (normalized.error) return { error: normalized.error };
  return { value: normalized.value };
}

function parseOptionalDateInput(raw, fieldName = 'date') {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null };
  }
  const normalized = normalizeDateInput(raw, { fieldName, allowEmpty: true });
  if (normalized.error) return { error: normalized.error };
  return { value: normalized.value };
}

/** Normalize known date fields on a plain object (mutates a shallow copy). */
function normalizeRecordDateFields(record, fieldNames) {
  const value = { ...record };
  for (const field of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const raw = record[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      value[field] = null;
      continue;
    }
    const parsed = normalizeDateInput(raw, { fieldName: field });
    if (parsed.error) return { error: parsed.error };
    value[field] = parsed.value;
  }
  return { value };
}

function addOneUtcDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function eachUtcDateKeyInRange(startKey, endKey) {
  if (!DATE_YMD_REGEX.test(startKey) || !DATE_YMD_REGEX.test(endKey) || startKey > endKey) return [];
  const dates = [];
  let cursor = startKey;
  while (true) {
    dates.push(cursor);
    if (cursor === endKey) break;
    cursor = addOneUtcDateKey(cursor);
  }
  return dates;
}

/** Calendar days between two YYYY-MM-DD keys, excluding any date present in holidayDateKeys. */
function computeBillableLeaveDays(fromDateKey, toDateKey, holidayDateKeys) {
  let billableDays = 0;
  for (const dateKey of eachUtcDateKeyInRange(fromDateKey, toDateKey)) {
    if (!holidayDateKeys.has(dateKey)) {
      billableDays += 1;
    }
  }
  return billableDays;
}

/** Calendar date (YYYY-MM-DD) in an IANA timezone for "today". */
function todayDateKeyInTimezone(timeZone) {
  const tz = String(timeZone || '').trim() || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    /* fall through */
  }
  return new Date().toISOString().slice(0, 10);
}

/** Payable reimbursement: selected date at 5:00 PM company-local, stored as UTC. */
function payableTimestampFromDate(dateYmd, timeZone = 'UTC') {
  const normalized = normalizeDateInput(dateYmd, { fieldName: 'date', allowEmpty: false });
  const dateKey = normalized.value;
  if (!dateKey) return null;
  const instant = localDateAndTimeToUtcInstant(dateKey, PAYABLE_DEFAULT_LOCAL_TIME, timeZone);
  return instant ? dateToPgUtcTimestamp(instant) : null;
}

/** Paid reimbursement: exact UTC moment when the status is recorded. */
function paidTimestampNow() {
  return utcNowForPgTimestamp();
}

function resolveExpenseReimbursementTimestamp(status, dateYmd, timeZone = 'UTC') {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'paid') {
    return paidTimestampNow();
  }
  return (
    payableTimestampFromDate(dateYmd, timeZone) ||
    payableTimestampFromDate(todayDateKeyInTimezone(timeZone), timeZone) ||
    paidTimestampNow()
  );
}

module.exports = {
  DATE_YMD_REGEX,
  DATE_INPUT_FORMAT_HINT,
  toUtcIsoString,
  toUtcTimestampString,
  utcNowForPgTimestamp,
  parseUtcDateTime,
  dateToPgUtcTimestamp,
  pgTimestampDateToUtcIso,
  toPgUtcTimestamp,
  toUtcDate,
  toDateKey,
  inclusiveCalendarDays,
  toUtcDateKey,
  utcDateKeyToIso,
  computeBillableLeaveDays,
  wallClockMinutesInTimezone,
  normalizeTimeHms,
  normalizeDateInput,
  parseRequiredDateInput,
  parseOptionalDateInput,
  parseDisplayDateToYmd,
  normalizeRecordDateFields,
  localDateAndTimeToUtcInstant,
  shiftTimeToCompanyLocalMinutes,
  payableTimestampFromDate,
  paidTimestampNow,
  resolveExpenseReimbursementTimestamp,
  todayDateKeyInTimezone,
};
