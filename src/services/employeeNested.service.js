

const { toUtcIsoString } = require('../utils/dateTime');
const { validateAccountNumber, validateIban } = require('../utils/bankValidation');

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

function serializeRowId(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'bigint') {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val.toString();
  }
  const n = Number(val);
  if (Number.isSafeInteger(n)) return n;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return String(val);
}

function firstOrSelf(val) {
  if (val === undefined || val === null) return {};
  if (Array.isArray(val)) {
    const first = val[0];
    return first && typeof first === 'object' ? first : {};
  }
  if (typeof val === 'object') return val;
  return {};
}

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

/** Normalize shift time to UTC wall-clock HH:mm:ss (Postgres TIME / JSONB). */
function normalizeTime(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;

  const timeOnly = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnly) {
    const hours = String(timeOnly[1]).padStart(2, '0');
    const minutes = timeOnly[2];
    const seconds = timeOnly[3] ?? '00';
    return `${hours}:${minutes}:${seconds}`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const hours = String(parsed.getUTCHours()).padStart(2, '0');
    const minutes = String(parsed.getUTCMinutes()).padStart(2, '0');
    const seconds = String(parsed.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  return null;
}

function formatTimeForApiResponse(value) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeTime(value);
  return normalized || null;
}

/** Parse documents array: { document_type_id | document_id | id, name?, file_url? } or bare id */
function parseDocumentsArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  for (const item of arr) {
    if (item === null || item === undefined) continue;
    let document_type_id;
    let name = null;
    let file_url = null;
    if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item.trim()))) {
      document_type_id = Number(item);
    } else if (typeof item === 'object') {
      const rawId = item.document_type_id ?? item.document_id ?? item.id;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') continue;
      document_type_id = Number(rawId);
      if (item.name !== undefined && item.name !== null && String(item.name).trim() !== '') {
        name = String(item.name).trim().slice(0, 200);
      }
      if (item.file_url !== undefined && item.file_url !== null && String(item.file_url).trim() !== '') {
        file_url = String(item.file_url).trim();
      }
    } else continue;
    if (!Number.isInteger(document_type_id) || document_type_id <= 0) continue;
    out.push({ document_type_id, name, file_url });
  }
  return out;
}

function parseDependantIdsArray(arr) {
  if (!Array.isArray(arr)) return [];
  const ids = [];
  for (const item of arr) {
    let raw;
    if (typeof item === 'object' && item !== null) {
      raw = item.id ?? item.dependant_id;
    } else {
      raw = item;
    }
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}


function validateAttendanceSchedulePayload(raw) {
  if (raw === undefined || raw === null) return { ok: true, row: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'attendance_schedule must be an object.' };
  }
  if (Object.keys(raw).length === 0) {
    return { ok: true, row: null };
  }

  const hasShiftId = Object.prototype.hasOwnProperty.call(raw, 'shift_id');
  const hasWorkLocationId = Object.prototype.hasOwnProperty.call(raw, 'work_location_id');
  if (hasShiftId || hasWorkLocationId) {
    const shiftId =
      raw.shift_id === null || raw.shift_id === undefined || String(raw.shift_id).trim() === ''
        ? null
        : Number(raw.shift_id);
    const workLocationId =
      raw.work_location_id === null ||
      raw.work_location_id === undefined ||
      String(raw.work_location_id).trim() === ''
        ? null
        : Number(raw.work_location_id);

    if (shiftId !== null && (!Number.isInteger(shiftId) || shiftId <= 0)) {
      return { ok: false, message: 'attendance_schedule.shift_id must be a positive integer.' };
    }
    if (workLocationId !== null && (!Number.isInteger(workLocationId) || workLocationId <= 0)) {
      return { ok: false, message: 'attendance_schedule.work_location_id must be a positive integer.' };
    }

    return {
      ok: true,
      row: {
        shift_id: shiftId,
        work_location_id: workLocationId,
      },
    };
  }

  const wd = parseWorkingDays(raw.working_days);
  if (!wd.ok) return { ok: false, message: wd.message };
  const shiftStart = normalizeTime(raw.shift_start);
  const shiftEnd = normalizeTime(raw.shift_end);
  if (!shiftStart || !shiftEnd) {
    return { ok: false, message: 'attendance_schedule requires shift_start and shift_end.' };
  }
  const br = parseBreakGrace(raw.break_minutes, 'break_minutes', 0);
  if (!br.ok) return { ok: false, message: br.message };
  const gr = parseBreakGrace(raw.grace_minutes, 'grace_minutes', 0);
  if (!gr.ok) return { ok: false, message: gr.message };
  const addr = parseAddress(raw.address);
  if (addr && addr.error) return { ok: false, message: addr.error };
  const latlng = parseOptionalLatLng(raw.latitude ?? raw.lat, raw.longitude ?? raw.lng);
  if (!latlng.ok) return { ok: false, message: latlng.message };

  return {
    ok: true,
    row: {
      working_days: JSON.stringify(wd.working_days),
      shift_start: shiftStart,
      shift_end: shiftEnd,
      break_minutes: br.value,
      grace_minutes: gr.value,
      address: addr ? addr.value : null,
      latitude: latlng.latitude,
      longitude: latlng.longitude,
    },
  };
}

/** Turn internal row from validateAttendanceSchedulePayload into the same JSON shape clients send (nothing is read from DB). */
function attendanceValidatedRowToResponse(row) {
  if (!row || typeof row !== 'object') return null;
  if (
    Object.prototype.hasOwnProperty.call(row, 'shift_id') ||
    Object.prototype.hasOwnProperty.call(row, 'work_location_id')
  ) {
    return {
      shift_id: serializeRowId(row.shift_id),
      work_location_id: serializeRowId(row.work_location_id),
    };
  }

  let workingDays = [];
  const raw = row.working_days;
  if (Array.isArray(raw)) {
    workingDays = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) workingDays = p;
    } catch {
      workingDays = [];
    }
  }
  return {
    working_days: workingDays,
    shift_start: formatTimeForApiResponse(row.shift_start),
    shift_end: formatTimeForApiResponse(row.shift_end),
    break_minutes: Number(row.break_minutes ?? 0),
    grace_minutes: Number(row.grace_minutes ?? 0),
    address: row.address ?? null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
  };
}

function parseEmployeeBankId(value) {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value.id ?? value.employee_bank_id ?? value.bank_detail_id ?? value.bank_details_id
      : value;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeBankString(value, field, maxLength, required = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return required ? { error: `${field} is required.` } : { value: null };
  }
  const s = String(value).trim();
  if (s.length > maxLength) return { error: `${field} must be at most ${maxLength} characters.` };
  return { value: s };
}

function parseEmployeeBankPayload(value) {
  if (value === undefined || value === null) return { ok: true, value: null, hasValue: false };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'employee_bank must be an object.' };
  }

  const hasBankDetailFields = ['bank_name', 'account_title', 'account_number', 'iban', 'branch_code', 'note'].some(
    (key) => Object.prototype.hasOwnProperty.call(value, key)
  );
  if (!hasBankDetailFields) return { ok: true, value: null, hasValue: true };

  const bankName = normalizeBankString(value.bank_name, 'employee_bank.bank_name', 100, true);
  if (bankName.error) return { ok: false, message: bankName.error };
  const accountTitle = normalizeBankString(value.account_title, 'employee_bank.account_title', 150, true);
  if (accountTitle.error) return { ok: false, message: accountTitle.error };

  const accountNumber = validateAccountNumber(value.account_number, { required: true });
  if (!accountNumber.valid) {
    return { ok: false, message: accountNumber.error || 'employee_bank.account_number is invalid.' };
  }

  const iban = validateIban(value.iban, { required: false });
  if (!iban.valid) {
    return { ok: false, message: iban.error || 'employee_bank.iban is invalid.' };
  }

  const branchCode = normalizeBankString(value.branch_code, 'employee_bank.branch_code', 20);
  if (branchCode.error) return { ok: false, message: branchCode.error };
  const note = normalizeBankString(value.note, 'employee_bank.note', 500);
  if (note.error) return { ok: false, message: note.error };

  return {
    ok: true,
    hasValue: true,
    value: {
      bank_name: bankName.value,
      account_title: accountTitle.value,
      account_number: accountNumber.value,
      iban: iban.value,
      branch_code: branchCode.value,
      note: note.value,
    },
  };
}

function normalizeStoredWorkingDays(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function minutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function durationMinutes(start, end) {
  const startMinutes = minutesFromTime(start);
  const endMinutes = minutesFromTime(end);
  if (startMinutes === null || endMinutes === null) return 0;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
}

function buildShiftObject(row) {
  if (!row?.shift_id) return null;
  const grossShiftMinutes = durationMinutes(row.shift_start_time, row.shift_end_time);
  const breakDurationMinutes =
    row.shift_break_start_time && row.shift_break_end_time
      ? durationMinutes(row.shift_break_start_time, row.shift_break_end_time)
      : 0;
  const excludeBreak = Boolean(row.shift_exclude_break_from_working_hours);
  const scheduledWorkMinutes = excludeBreak
    ? Math.max(grossShiftMinutes - breakDurationMinutes, 0)
    : grossShiftMinutes;

  return {
    id: serializeRowId(row.shift_id),
    name: row.shift_name ?? null,
    start_time: formatTimeForApiResponse(row.shift_start_time),
    end_time: formatTimeForApiResponse(row.shift_end_time),
    break_start_time: formatTimeForApiResponse(row.shift_break_start_time),
    break_end_time: formatTimeForApiResponse(row.shift_break_end_time),
    working_days: normalizeStoredWorkingDays(row.shift_working_days),
    exclude_break_from_working_hours: excludeBreak,
    working_hours_threshold_minutes: Number(row.shift_working_hours_threshold_minutes ?? 0),
    gross_shift_minutes: grossShiftMinutes,
    gross_shift_hours: Number((grossShiftMinutes / 60).toFixed(2)),
    break_duration_minutes: breakDurationMinutes,
    break_duration_hours: Number((breakDurationMinutes / 60).toFixed(2)),
    scheduled_work_minutes: scheduledWorkMinutes,
    scheduled_work_hours: Number((scheduledWorkMinutes / 60).toFixed(2)),
    is_active: Boolean(row.shift_is_active),
    created_at: toUtcIsoString(row.shift_created_at),
    updated_at: toUtcIsoString(row.shift_updated_at),
  };
}

async function resolveDepartmentName(client, companyId, departmentId) {
  if (departmentId === undefined || departmentId === null || String(departmentId).trim() === '') {
    return { ok: true, name: null };
  }
  const id = Number(departmentId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'department_id must be a positive integer.' };
  const r = await client.query(`SELECT name FROM departments WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (r.rowCount === 0) return { ok: false, message: 'department_id not found for this company.' };
  return { ok: true, name: r.rows[0].name };
}

async function resolveDesignationName(client, companyId, designationId) {
  if (designationId === undefined || designationId === null || String(designationId).trim() === '') {
    return { ok: true, name: null };
  }
  const id = Number(designationId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'designation_id must be a positive integer.' };
  const r = await client.query(`SELECT name FROM designations WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (r.rowCount === 0) return { ok: false, message: 'designation_id not found for this company.' };
  return { ok: true, name: r.rows[0].name };
}

async function resolveEmployeeTypeId(client, companyId, employeeTypeId) {
  if (employeeTypeId === undefined || employeeTypeId === null || String(employeeTypeId).trim() === '') {
    return { ok: true, id: null };
  }
  const id = Number(employeeTypeId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, message: 'employee_type_id must be a positive integer.' };
  }
  const r = await client.query(`SELECT id FROM employee_types WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (r.rowCount === 0) return { ok: false, message: 'employee_type_id not found for this company.' };
  return { ok: true, id };
}

async function resolveRoleId(client, companyId, roleId) {
  if (roleId === undefined || roleId === null || String(roleId).trim() === '') {
    return { ok: true, id: null };
  }
  const id = Number(roleId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, message: 'role_id must be a positive integer.' };
  }
  const r = await client.query(`SELECT id, label, value FROM employee_roles WHERE id = $1 AND company_id = $2`, [
    id,
    companyId,
  ]);
  if (r.rowCount === 0) return { ok: false, message: 'role_id not found for this company.' };
  return { ok: true, id, label: r.rows[0].label, value: r.rows[0].value };
}

async function resolveAccessRoleId(client, companyId, accessRoleId) {
  if (accessRoleId === undefined || accessRoleId === null || String(accessRoleId).trim() === '') {
    return { ok: true, id: null, name: null };
  }
  const id = Number(accessRoleId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, message: 'access_role_id must be a positive integer.' };
  }
  const r = await client.query(`SELECT id, name FROM access_roles WHERE id = $1 AND company_id = $2`, [
    id,
    companyId,
  ]);
  if (r.rowCount === 0) return { ok: false, message: 'access_role_id not found for this company.' };
  return { ok: true, id, name: r.rows[0].name };
}

async function ensureEmployeesAttendanceScheduleColumn(client) {
  await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS attendance_schedule JSONB`);
}

// The ALTER TABLE ... IF NOT EXISTS statements below are idempotent, so they
// only need to run once per process instead of on every request (each one is
// a full database round trip).
let employeeProfileSchemaEnsured = false;

async function ensureEmployeeProfileSchema(client) {
  if (employeeProfileSchemaEnsured) return;
  await client.query(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS marital_status VARCHAR(30),
      ADD COLUMN IF NOT EXISTS religion VARCHAR(60),
      ADD COLUMN IF NOT EXISTS national_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS national_id_expiry DATE,
      ADD COLUMN IF NOT EXISTS dependant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS attendance_schedule JSONB
  `);

  await client.query(`
    ALTER TABLE employee_job_details
      ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS designation_id BIGINT REFERENCES designations(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS employee_type_id BIGINT REFERENCES employee_types(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS role_id BIGINT REFERENCES employee_roles(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS joining_date DATE,
      ADD COLUMN IF NOT EXISTS probation_end_date DATE,
      ADD COLUMN IF NOT EXISTS contract_end_date DATE,
      ADD COLUMN IF NOT EXISTS medical_allowance NUMERIC(12, 2),
      ADD COLUMN IF NOT EXISTS conveyance_allowance NUMERIC(12, 2),
      ADD COLUMN IF NOT EXISTS other_allowance NUMERIC(12, 2),
      ADD COLUMN IF NOT EXISTS salary_effective_date DATE,
      ADD COLUMN IF NOT EXISTS tax_exemption_status VARCHAR(50),
      ADD COLUMN IF NOT EXISTS eobi_applicable BOOLEAN,
      ADD COLUMN IF NOT EXISTS work_location_id BIGINT,
      ADD COLUMN IF NOT EXISTS currency VARCHAR(10),
      ADD COLUMN IF NOT EXISTS line_manager_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS access_role_id BIGINT REFERENCES access_roles(id) ON DELETE SET NULL
  `);

  await client.query(`
    ALTER TABLE employee_bank_details
      ADD COLUMN IF NOT EXISTS id BIGINT,
      ADD COLUMN IF NOT EXISTS account_title VARCHAR(150),
      ADD COLUMN IF NOT EXISTS account_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS branch_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS note TEXT
  `);
  employeeProfileSchemaEnsured = true;
}

/** Persists nested attendance on `employees.attendance_schedule` (JSONB). Uses a savepoint so a failed first UPDATE does not abort the outer transaction. */
async function upsertAttendanceProfile(client, employeeId, companyId, attendanceRow) {
  const snapshot = attendanceRow
    ? attendanceValidatedRowToResponse(attendanceRow)
    : null;
  const payload = snapshot ? JSON.stringify(snapshot) : null;

  const writeSql = `UPDATE employees SET attendance_schedule = $1::jsonb WHERE id = $2 AND company_id = $3`;
  const writeParams = [payload, employeeId, companyId];

  await client.query('SAVEPOINT sp_emp_attendance');
  try {
    await client.query(writeSql, writeParams);
    await client.query('RELEASE SAVEPOINT sp_emp_attendance');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_emp_attendance');
    if (err && err.code === '42703') {
      try {
        await ensureEmployeesAttendanceScheduleColumn(client);
      } catch (alterErr) {
        console.warn('[hrm] Could not add employees.attendance_schedule; skipping persist.', alterErr.message);
        return;
      }
      await client.query(writeSql, writeParams);
      return;
    }
    throw err;
  }
}

async function replaceEmployeeDocuments(client, employeeId, companyId, docs) {
  await client.query(`DELETE FROM employee_documents WHERE employee_id = $1`, [employeeId]);
  if (!docs || docs.length === 0) return;
  for (const d of docs) {
    const typeCheck = await client.query(
      `SELECT id, label, value FROM document_types WHERE id = $1 AND company_id = $2`,
      [d.document_type_id, companyId]
    );
    if (typeCheck.rowCount === 0) {
      const err = new Error(`DOCUMENT_TYPE_NOT_FOUND:${d.document_type_id}`);
      throw err;
    }
    const dt = typeCheck.rows[0];
    const titleRaw =
      (d.name != null && String(d.name).trim() !== '' && String(d.name).trim()) ||
      String(dt.label || '').trim() ||
      String(dt.value || '').trim() ||
      'Document';
    const title = titleRaw.slice(0, 200);
    const typeValue = String(dt.value || '').trim().slice(0, 120);
    const typeLabel = String(dt.label || '').trim().slice(0, 120);
    const documentType = typeValue || typeLabel || 'other';
    const fileUrl =
      d.file_url != null && String(d.file_url).trim() !== '' ? String(d.file_url).trim() : '';

    await client.query(
      `INSERT INTO employee_documents (employee_id, title, document_type, file_url, uploaded_on)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
      [employeeId, title, documentType, fileUrl]
    );
  }
}

function parseDependantIdsFromStored(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? parseDependantIdsFromStored(p) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function saveEmployeeDependantIds(client, employeeId, companyId, dependantIds) {
  const ids = dependantIds && dependantIds.length ? [...new Set(dependantIds)] : [];
  for (const depId of ids) {
    const check = await client.query(
      `SELECT id FROM employee_dependants WHERE id = $1 AND company_id = $2`,
      [depId, companyId]
    );
    if (check.rowCount === 0) {
      throw new Error(`DEPENDANT_NOT_FOUND:${depId}`);
    }
  }
  await client.query(`UPDATE employees SET dependant_ids = $1::jsonb WHERE id = $2 AND company_id = $3`, [
    JSON.stringify(ids),
    employeeId,
    companyId,
  ]);
}

async function fetchAttendanceProfile(client, employeeId, companyId) {
  let r;
  try {
    r = await client.query(
      `SELECT attendance_schedule FROM employees WHERE id = $1 AND company_id = $2`,
      [employeeId, companyId]
    );
  } catch (err) {
    if (err && err.code === '42703') return null;
    throw err;
  }
  if (r.rowCount === 0) return null;
  const val = r.rows[0].attendance_schedule;
  if (val == null) return null;
  return attendanceValidatedRowToResponse({
    shift_id: val.shift_id,
    work_location_id: val.work_location_id,
    working_days: val.working_days,
    shift_start: val.shift_start,
    shift_end: val.shift_end,
    break_minutes: val.break_minutes,
    grace_minutes: val.grace_minutes,
    address: val.address,
    latitude: val.latitude,
    longitude: val.longitude,
  });
}

async function fetchDocumentsWithTypes(client, employeeId, companyId) {
  const r = await client.query(
    `SELECT DISTINCT ON (ed.id)
            ed.id,
            ed.title AS doc_title,
            ed.document_type AS stored_document_type,
            ed.file_url,
            dt.id AS document_type_id,
            dt.label AS document_type_name,
            dt.value AS document_type_value
     FROM employee_documents ed
     INNER JOIN employees e ON e.id = ed.employee_id AND e.company_id = $2
     LEFT JOIN document_types dt
       ON dt.company_id = $2 AND (dt.value = ed.document_type OR dt.label = ed.document_type)
     WHERE ed.employee_id = $1
     ORDER BY ed.id, dt.id NULLS LAST`,
    [employeeId, companyId]
  );
  return r.rows.map((row) => ({
    id: serializeRowId(row.id),
    document_type_id: serializeRowId(row.document_type_id),
    name: row.doc_title,
    file_url: row.file_url,
    document_type_name: row.document_type_name ?? row.stored_document_type,
    document_type_value: row.document_type_value ?? row.stored_document_type,
    source: 'employee_profile',
  }));
}

async function fetchHrUploadedDocumentsForEmployee(client, employeeId, companyId) {
  const r = await client.query(
    `SELECT hdr.id,
            hdr.document_type,
            hdr.title,
            hdr.file_url,
            hdr.file_name,
            hdr.status,
            hdr.created_at,
            hdr.updated_at
     FROM hr_document_requirements hdr
     WHERE hdr.employee_id = $1
       AND hdr.company_id = $2
       AND hdr.file_url IS NOT NULL
       AND BTRIM(hdr.file_url) <> ''
       AND hdr.status IN ('uploaded', 'approved')
     ORDER BY hdr.updated_at DESC NULLS LAST, hdr.id DESC`,
    [employeeId, companyId]
  );

  return r.rows.map((row) => ({
    id: `hr-${serializeRowId(row.id)}`,
    hr_document_id: serializeRowId(row.id),
    name: row.title || row.document_type,
    file_url: row.file_url,
    file_name: row.file_name,
    document_type_name: row.document_type,
    document_type_value: row.document_type,
    source: 'hr_request',
    status: row.status,
    uploaded_on: row.updated_at ?? row.created_at,
  }));
}

/**
 * Onboarding self-service uploads (onboarding_documents — the approval-workflow table,
 * distinct from employee_documents) surfaced in the same documents[] shape as
 * fetchDocumentsWithTypes/fetchHrUploadedDocumentsForEmployee, so every caller of
 * buildNestedEmployeePayload (GET /employees/:id, GET /employee-onboarding/me, etc.) sees
 * them without needing to know about the separate onboarding_documents checklist.
 */
async function fetchOnboardingDocumentsForEmployee(client, employeeId, companyId) {
  const r = await client.query(
    `SELECT od.id, od.document_type_id, od.file_url, od.file_name, od.status,
            od.updated_at, od.created_at,
            dt.label AS document_type_name, dt.value AS document_type_value
     FROM onboarding_documents od
     LEFT JOIN document_types dt ON dt.id = od.document_type_id
     WHERE od.employee_id = $1
       AND od.company_id = $2
       AND od.file_url IS NOT NULL
       AND BTRIM(od.file_url) <> ''
     ORDER BY od.updated_at DESC NULLS LAST, od.id DESC`,
    [employeeId, companyId]
  );

  return r.rows.map((row) => ({
    id: `onboarding-${serializeRowId(row.id)}`,
    onboarding_document_id: serializeRowId(row.id),
    document_type_id: serializeRowId(row.document_type_id),
    name: row.file_name || row.document_type_name,
    file_url: row.file_url,
    file_name: row.file_name,
    document_type_name: row.document_type_name,
    document_type_value: row.document_type_value,
    source: 'onboarding',
    status: row.status,
    uploaded_on: row.updated_at ?? row.created_at,
  }));
}

async function fetchDependantsForEmployee(client, employeeId, companyId) {
  const er = await client.query(`SELECT dependant_ids FROM employees WHERE id = $1 AND company_id = $2`, [
    employeeId,
    companyId,
  ]);
  if (er.rowCount === 0) return [];
  const ids = parseDependantIdsFromStored(er.rows[0].dependant_ids);
  if (ids.length === 0) return [];
  const r = await client.query(
    `SELECT id, full_name, relationship, relationship_label, phone_no
     FROM employee_dependants
     WHERE company_id = $1 AND id = ANY($2::bigint[])`,
    [companyId, ids]
  );
  const byId = new Map(r.rows.map((row) => [String(row.id), row]));
  return ids
    .map((id) => {
      const row = byId.get(String(id));
      if (!row) return null;
      return {
        id: serializeRowId(row.id),
        dependant_id: serializeRowId(row.id),
        full_name: row.full_name,
        name: row.full_name,
        relationship: row.relationship,
        relationship_label: row.relationship_label ?? null,
        phone_no: row.phone_no,
      };
    })
    .filter(Boolean);
}

async function fetchBankDetailsForEmployee(client, employeeId, companyId) {
  const r = await client.query(
    `SELECT ebd.id, ebd.employee_id, ebd.bank_name, ebd.account_title, ebd.account_number,
            ebd.iban, ebd.branch_code, ebd.note, ebd.created_at, ebd.updated_at
     FROM employee_bank_details ebd
     INNER JOIN employees e ON e.id = ebd.employee_id
     WHERE ebd.employee_id = $1 AND e.company_id = $2
     LIMIT 1`,
    [employeeId, companyId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: serializeRowId(row.id),
    employee_id: serializeRowId(row.employee_id),
    bank_name: row.bank_name,
    account_title: row.account_title,
    account_number: row.account_number,
    iban: row.iban ?? null,
    branch_code: row.branch_code ?? null,
    note: row.note ?? null,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

async function validateEmployeeBankBelongsToEmployee(client, employeeId, companyId, bankId) {
  const parsedBankId = parseEmployeeBankId(bankId);
  if (!parsedBankId) {
    return { ok: false, message: 'employee_bank.id must be a positive integer.' };
  }
  const r = await client.query(
    `SELECT ebd.id
     FROM employee_bank_details ebd
     INNER JOIN employees e ON e.id = ebd.employee_id
     WHERE ebd.id = $1 AND ebd.employee_id = $2 AND e.company_id = $3`,
    [parsedBankId, employeeId, companyId]
  );
  if (r.rowCount === 0) {
    return { ok: false, message: 'employee_bank.id was not found for this employee and company.' };
  }
  return { ok: true, id: parsedBankId };
}

async function upsertEmployeeBankDetails(client, employeeId, companyId, bankDetails) {
  if (!bankDetails) return null;
  const employeeCheck = await client.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [
    employeeId,
    companyId,
  ]);
  if (employeeCheck.rowCount === 0) {
    throw new Error(`EMPLOYEE_NOT_FOUND:${employeeId}`);
  }

  const result = await client.query(
    `INSERT INTO employee_bank_details (
       employee_id, bank_name, account_title, account_number, iban, branch_code, note, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (employee_id)
     DO UPDATE SET
       bank_name = EXCLUDED.bank_name,
       account_title = EXCLUDED.account_title,
       account_number = EXCLUDED.account_number,
       iban = EXCLUDED.iban,
       branch_code = EXCLUDED.branch_code,
       note = EXCLUDED.note,
       updated_at = NOW()
     RETURNING id`,
    [
      employeeId,
      bankDetails.bank_name,
      bankDetails.account_title,
      bankDetails.account_number,
      bankDetails.iban,
      bankDetails.branch_code,
      bankDetails.note,
    ]
  );
  return result.rows[0]?.id ?? null;
}

const EMPLOYEE_DETAIL_SELECT_FIELDS = `
  id, gender, profile_picture_url, employee_id, work_email, first_name, last_name, father_name, mother_name,
  blood_group, qualification, dob, marital_status, religion, employee_code, attendance_machine_code,
  national_id, national_id_expiry, passport_no, passport_expiry, eobi_number, ntn_no,
  country, state_province, city, zip_postal_code, nationality, permanent_address, temporary_address,
  personal_email, home_phone, work_phone_mobile, emergency_contact_name, emergency_contact_no, created_at,
  onboarding_status, invited_at, onboarding_submitted_at, onboarding_activated_at,
  lms_required, lms_completed_at
`;

const OFFICIAL_INFO_SELECT_FIELDS = `
  ejd.id, ejd.designation, ejd.department, ejd.department_id, ejd.designation_id,
  ejd.employee_type_id, et.label AS employee_type_label, et.value AS employee_type_value,
  ejd.role_id, er.label AS role_label, er.value AS role_value,
  ejd.shift_id, s.name AS shift_name, s.start_time AS shift_start_time, s.end_time AS shift_end_time,
  s.break_start_time AS shift_break_start_time, s.break_end_time AS shift_break_end_time,
  s.working_days AS shift_working_days, s.exclude_break_from_working_hours AS shift_exclude_break_from_working_hours,
  s.working_hours_threshold_minutes AS shift_working_hours_threshold_minutes,
  s.is_active AS shift_is_active, s.created_at AS shift_created_at, s.updated_at AS shift_updated_at,
  ejd.work_location_id, wl.name AS work_location_name, wl.country AS work_location_country,
  wl.city AS work_location_city, wl.postal_code AS work_location_postal_code,
  wl.address AS work_location_address, wl.latitude AS work_location_latitude,
  wl.longitude AS work_location_longitude, wl.radius_meters AS work_location_radius_meters,
  wl.geofencing_enabled AS work_location_geofencing_enabled,
  ejd.location, ejd.hire_date, ejd.joining_date, ejd.probation_end_date, ejd.contract_end_date,
  ejd.salary, ejd.salary_type, ejd.currency, ejd.medical_allowance, ejd.conveyance_allowance,
  ejd.other_allowance, ejd.salary_effective_date, ejd.tax_exemption_status, ejd.eobi_applicable,
  ejd.line_manager_id,
  NULLIF(TRIM(CONCAT(COALESCE(lm.first_name, ''), ' ', COALESCE(lm.last_name, ''))), '') AS line_manager_name,
  lm.employee_code AS line_manager_employee_no,
  lm.work_email AS line_manager_email,
  ejd.access_role_id AS staged_access_role_id, ar.name AS staged_access_role_name
`;

function deriveEmployeeStatusFromUser(userRow) {
  if (!userRow) return null;
  // Employees still going through the Invite Employee onboarding flow have no
  // `users` row yet — surface their onboarding_status instead of falling
  // through to the invite/active/inactive logic below.
  if (userRow.onboarding_status === 'pending_invite' || userRow.onboarding_status === 'pre_boarding') {
    return userRow.onboarding_status;
  }
  if (userRow.is_active === true) return 'active';
  if (userRow.signup_type === 'invite') return 'pending';
  return 'inactive';
}

async function fetchOfficialInfoByEmployeeId(db, employeeId) {
  const result = await db.query(
    `SELECT ${OFFICIAL_INFO_SELECT_FIELDS}
     FROM employee_job_details ejd
     LEFT JOIN shifts s ON s.id = ejd.shift_id
     LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
     LEFT JOIN employee_types et ON et.id = ejd.employee_type_id
     LEFT JOIN employee_roles er ON er.id = ejd.role_id
     LEFT JOIN employees lm ON lm.id = ejd.line_manager_id
     LEFT JOIN access_roles ar ON ar.id = ejd.access_role_id
     WHERE ejd.employee_id = $1`,
    [employeeId]
  );
  return result.rows[0] || null;
}


async function fetchFullEmployeeProfileDetails(db, { employeeId, companyId, userRow = null }) {
  const parsedEmployeeId = Number(employeeId);
  const parsedCompanyId = Number(companyId);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) return null;
  if (!Number.isInteger(parsedCompanyId) || parsedCompanyId <= 0) return null;

  await ensureEmployeeProfileSchema(db);

  // officialInfo only depends on employeeId (not on the employees row itself), so it can be
  // fetched concurrently with the employees row instead of waiting on it first.
  const [empResult, officialInfo] = await Promise.all([
    db.query(
      `SELECT ${EMPLOYEE_DETAIL_SELECT_FIELDS}
       FROM employees
       WHERE id = $1 AND company_id = $2`,
      [parsedEmployeeId, parsedCompanyId]
    ),
    fetchOfficialInfoByEmployeeId(db, parsedEmployeeId),
  ]);
  if (empResult.rowCount === 0) return null;

  const employee = empResult.rows[0];
  const nestedPayload = await buildNestedEmployeePayload(db, employee, officialInfo, parsedCompanyId);
  if (nestedPayload?.official && userRow) {
    // A real users row exists (activated employee) — it's the source of truth for the
    // permission role, overriding the staged employee_job_details value buildNestedEmployeePayload
    // set by default. Some callers (e.g. auth.controller's /auth/profile) pass a userRow that
    // carries access_role_id but never joined access_role_name — resolve it here so every
    // caller of this shared builder gets a correct name either way.
    let accessRoleName = userRow.access_role_name;
    if (accessRoleName === undefined && userRow.access_role_id) {
      const accessRoleResult = await db.query(`SELECT name FROM access_roles WHERE id = $1`, [
        userRow.access_role_id,
      ]);
      accessRoleName = accessRoleResult.rows[0]?.name ?? null;
    }
    nestedPayload.official.access_role_id = serializeRowId(userRow.access_role_id);
    nestedPayload.official.access_role_name = accessRoleName ?? null;
  }
  // else: no login account yet (still pending_invite/pre_boarding) — official.access_role_id/
  // access_role_name were already populated from the staged employee_job_details column, i.e.
  // the role Company Admin picked at invite time, visible to the employee read-only until activation.

  return {
    email: employee.work_email || employee.personal_email || null,
    employee_id: serializeRowId(parsedEmployeeId),
    onboarding_status: employee.onboarding_status ?? 'active',
    invited_at: toUtcIsoString(employee.invited_at),
    onboarding_submitted_at: toUtcIsoString(employee.onboarding_submitted_at),
    onboarding_activated_at: toUtcIsoString(employee.onboarding_activated_at),
    lms_required: employee.lms_required === true,
    lms_completed_at: toUtcIsoString(employee.lms_completed_at),
    status: deriveEmployeeStatusFromUser({ ...userRow, onboarding_status: employee.onboarding_status }),
    ...nestedPayload,
  };
}

async function buildNestedEmployeePayload(db, employeeRow, officialRow, companyId) {
  const employeeId = employeeRow.id;
  // These seven lookups are all independent (keyed only on employeeId/companyId), so run them
  // concurrently instead of one round trip at a time — this is the bulk of /auth/profile's cost.
  const lineManagerService = officialRow ? require('./lineManager.service') : null;
  const [
    attendance_schedule,
    profileDocuments,
    hrDocuments,
    onboardingDocuments,
    dependants,
    employeeBank,
    managersPayload,
  ] = await Promise.all([
    fetchAttendanceProfile(db, employeeId, companyId),
    fetchDocumentsWithTypes(db, employeeId, companyId),
    fetchHrUploadedDocumentsForEmployee(db, employeeId, companyId),
    fetchOnboardingDocumentsForEmployee(db, employeeId, companyId),
    fetchDependantsForEmployee(db, employeeId, companyId),
    fetchBankDetailsForEmployee(db, employeeId, companyId),
    lineManagerService
      ? lineManagerService.loadEmployeeLineManagersByEmployeeId(db, companyId, employeeId)
      : Promise.resolve(null),
  ]);
  const documents = [...profileDocuments, ...hrDocuments, ...onboardingDocuments];

  const personal = {
    id: serializeRowId(employeeRow.id),
    // Falls back to personal_email so pending-onboarding employees (no work_email
    // assigned yet) still show a usable email — same convention as the employees list.
    email: employeeRow.work_email || employeeRow.personal_email || null,
    work_email: employeeRow.work_email,
    personal_email: employeeRow.personal_email,
    employee_code: employeeRow.employee_code,
    profile_image: employeeRow.profile_picture_url,
    profile_picture_url: employeeRow.profile_picture_url,
    first_name: employeeRow.first_name,
    last_name: employeeRow.last_name,
    father_name: employeeRow.father_name,
    mother_name: employeeRow.mother_name,
    blood_group: employeeRow.blood_group,
    qualification: employeeRow.qualification,
    dob: employeeRow.dob,
    phone_no: employeeRow.home_phone,
    work_phone_mobile: employeeRow.work_phone_mobile,
    current_address: employeeRow.temporary_address,
    permanent_address: employeeRow.permanent_address,
    gender: employeeRow.gender,
    country: employeeRow.country,
    state_province: employeeRow.state_province,
    city: employeeRow.city,
    zip_postal_code: employeeRow.zip_postal_code,
    nationality: employeeRow.nationality,
    marital_status: employeeRow.marital_status,
    religion: employeeRow.religion,
    cnic: employeeRow.national_id,
    cnic_expiry: employeeRow.national_id_expiry,
    national_id: employeeRow.national_id,
    national_id_expiry: employeeRow.national_id_expiry,
    passport_no: employeeRow.passport_no,
    passport_expiry: employeeRow.passport_expiry,
    eobi_number: employeeRow.eobi_number,
    ntn_no: employeeRow.ntn_no,
    attendance_machine_code: employeeRow.attendance_machine_code,
    emergency_contact_name: employeeRow.emergency_contact_name,
    emergency_contact_no: employeeRow.emergency_contact_no,
    created_at: toUtcIsoString(employeeRow.created_at),
  };

  const official = officialRow
    ? {
        hire_date: officialRow.hire_date,
        joining_date: officialRow.joining_date ?? officialRow.hire_date,
        probation_end_date: officialRow.probation_end_date,
        contract_end_date: officialRow.contract_end_date,
        office_location: officialRow.location,
        location: officialRow.location,
        work_location_id: serializeRowId(officialRow.work_location_id),
        work_location_name: officialRow.work_location_name ?? null,
        work_location: officialRow.work_location_id
          ? {
              id: serializeRowId(officialRow.work_location_id),
              name: officialRow.work_location_name ?? null,
              country: officialRow.work_location_country ?? null,
              city: officialRow.work_location_city ?? null,
              postal_code: officialRow.work_location_postal_code ?? null,
              address: officialRow.work_location_address ?? null,
              latitude:
                officialRow.work_location_latitude != null ? Number(officialRow.work_location_latitude) : null,
              longitude:
                officialRow.work_location_longitude != null ? Number(officialRow.work_location_longitude) : null,
              radius_meters:
                officialRow.work_location_radius_meters != null
                  ? Number(officialRow.work_location_radius_meters)
                  : null,
              geofencing_enabled: Boolean(officialRow.work_location_geofencing_enabled),
            }
          : null,
        department: officialRow.department,
        department_id: serializeRowId(officialRow.department_id),
        designation: officialRow.designation,
        designation_id: serializeRowId(officialRow.designation_id),
        employee_type_id: serializeRowId(officialRow.employee_type_id),
        employee_type_label: officialRow.employee_type_label ?? null,
        employee_type_value: officialRow.employee_type_value ?? null,
        role_id: serializeRowId(officialRow.role_id),
        role_label: officialRow.role_label ?? null,
        role_value: officialRow.role_value ?? null,
        // Permission role picked at invite time, staged on employee_job_details since
        // there's no `users` row (and therefore no users.access_role_id) until activation.
        // fetchFullEmployeeProfileDetails overrides these with the real users.access_role_id
        // once a login account exists — this stays the source of truth only until then.
        access_role_id: serializeRowId(officialRow.staged_access_role_id),
        access_role_name: officialRow.staged_access_role_name ?? null,
        shift_id: serializeRowId(officialRow.shift_id),
        shift_name: officialRow.shift_name,
        shift: buildShiftObject(officialRow),
        line_manager_id: serializeRowId(officialRow.line_manager_id),
        line_manager_name: officialRow.line_manager_name ?? null,
        line_manager_email: officialRow.line_manager_email ?? null,
        line_manager: officialRow.line_manager_id
          ? {
              id: serializeRowId(officialRow.line_manager_id),
              name: officialRow.line_manager_name ?? null,
              email: officialRow.line_manager_email ?? null,
              employee_no: officialRow.line_manager_employee_no ?? null,
            }
          : null,
      }
    : null;

  if (official) {
    official.line_managers = managersPayload.line_managers || [];
    const primaryManager =
      managersPayload.line_managers.find((manager) => manager.role === 'primary') || null;
    if (primaryManager) {
      official.line_manager_id = serializeRowId(primaryManager.id);
      official.line_manager_name = primaryManager.name ?? null;
      official.line_manager_email = primaryManager.email ?? null;
      official.line_manager = {
        id: serializeRowId(primaryManager.id),
        name: primaryManager.name ?? null,
        email: primaryManager.email ?? null,
        employee_no: primaryManager.employee_no ?? null,
      };
    }
  }

  const salary =
    officialRow &&
    (officialRow.salary != null ||
      officialRow.salary_type != null ||
      officialRow.currency != null ||
      officialRow.medical_allowance != null ||
      officialRow.conveyance_allowance != null ||
      officialRow.other_allowance != null ||
      officialRow.salary_effective_date != null ||
      officialRow.tax_exemption_status != null ||
      officialRow.eobi_applicable != null)
      ? {
          salary_type: officialRow.salary_type,
          amount: officialRow.salary,
          currency: officialRow.currency ?? null,
          medical_allowance: officialRow.medical_allowance,
          conveyance_allowance: officialRow.conveyance_allowance,
          other_allowance: officialRow.other_allowance,
          salary_effective_date: officialRow.salary_effective_date,
          tax_exemption_status: officialRow.tax_exemption_status,
          eobi_applicable: officialRow.eobi_applicable,
        }
      : null;

  const enrichedAttendanceSchedule = attendance_schedule
    ? {
        ...attendance_schedule,
        shift: official?.shift ?? null,
        work_location: official?.work_location ?? null,
      }
    : null;

  return {
    personal,
    official,
    salary,
    attendance_schedule: enrichedAttendanceSchedule,
    documents,
    dependants,
    employee_bank: employeeBank,
    bank_details: employeeBank,
  };
}


function flattenNestedPatchForUpdate(body) {
  const out = {};
  let department_id;
  let designation_id;
  let employee_type_id;
  let role_id;
  let access_role_id;
  let line_managers;

  const personal = firstOrSelf(body.personal);
  if (body.personal !== undefined && body.personal !== null) {
    if (personal.profile_image !== undefined) out.profile_picture_url = personal.profile_image;
    if (personal.profile_picture_url !== undefined) out.profile_picture_url = personal.profile_picture_url;
    if (personal.first_name !== undefined) out.first_name = personal.first_name;
    if (personal.last_name !== undefined) out.last_name = personal.last_name;
    if (personal.employee_code !== undefined) out.employee_code = personal.employee_code;
    if (personal.dob !== undefined) out.dob = personal.dob;
    if (personal.phone_no !== undefined) out.home_phone = personal.phone_no;
    if (personal.phone_number !== undefined) out.home_phone = personal.phone_number;
    if (personal.current_address !== undefined) out.temporary_address = personal.current_address;
    if (personal.temporary_address !== undefined) out.temporary_address = personal.temporary_address;
    if (personal.permanent_address !== undefined) out.permanent_address = personal.permanent_address;
    if (personal.gender !== undefined) out.gender = personal.gender;
    if (personal.country !== undefined) out.country = personal.country;
    if (personal.marital_status !== undefined) out.marital_status = personal.marital_status;
    if (personal.religion !== undefined) out.religion = personal.religion;
    if (personal.cnic !== undefined) out.national_id = personal.cnic;
    if (personal.national_id !== undefined) out.national_id = personal.national_id;
    if (personal.cnic_expiry !== undefined) out.national_id_expiry = personal.cnic_expiry;
    if (personal.cnic_expiry_date !== undefined) out.national_id_expiry = personal.cnic_expiry_date;
    if (personal.national_id_expiry !== undefined) out.national_id_expiry = personal.national_id_expiry;
  }

  const official = firstOrSelf(body.official);
  if (body.official !== undefined && body.official !== null) {
    if (official.designation !== undefined) out.designation = official.designation;
    if (official.department !== undefined) out.department = official.department;
    if (official.shift_id !== undefined) out.shift_id = official.shift_id;
    if (official.office_location !== undefined) out.location = official.office_location;
    if (official.location !== undefined) out.location = official.location;
    if (official.hire_date !== undefined) out.hire_date = official.hire_date;
    else if (official.joining_date !== undefined) out.hire_date = official.joining_date;
    if (official.joining_date !== undefined) out.joining_date = official.joining_date;
    if (official.probation_end_date !== undefined) out.probation_end_date = official.probation_end_date;
    if (official.contract_end_date !== undefined) out.contract_end_date = official.contract_end_date;
    if (official.department_id !== undefined) {
      department_id = official.department_id;
      out.department_id = official.department_id;
    }
    if (official.designation_id !== undefined) {
      designation_id = official.designation_id;
      out.designation_id = official.designation_id;
    }
    if (official.employee_type_id !== undefined) {
      employee_type_id = official.employee_type_id;
      out.employee_type_id = official.employee_type_id;
    }
    if (official.role_id !== undefined) {
      role_id = official.role_id;
      out.role_id = official.role_id;
    }
    // access_role_id lives on users, not employee_job_details — kept out of `out`
    // so it isn't picked up by the employee_job_details column allowlist.
    if (official.access_role_id !== undefined) {
      access_role_id = official.access_role_id;
    }
    if (official.line_manager_id !== undefined) {
      out.line_manager_id = official.line_manager_id;
    }
    if (official.line_managers !== undefined) {
      line_managers = official.line_managers;
    }
  }

  const attendanceSchedule = firstOrSelf(body.attendance_schedule ?? body.attendanceSchedule);
  if (body.attendance_schedule !== undefined || body.attendanceSchedule !== undefined) {
    if (attendanceSchedule.shift_id !== undefined) out.shift_id = attendanceSchedule.shift_id;
    if (attendanceSchedule.work_location_id !== undefined) {
      out.work_location_id = attendanceSchedule.work_location_id;
    }
  }

  if (body.salary !== undefined && body.salary !== null) {
    const s = body.salary;
    if (s.amount !== undefined) out.salary = s.amount;
    if (s.salary !== undefined) out.salary = s.salary;
    if (s.salary_type !== undefined) out.salary_type = s.salary_type;
    if (s.currency !== undefined) out.currency = s.currency;
    if (s.medical_allowance !== undefined) out.medical_allowance = s.medical_allowance;
    if (s.conveyance_allowance !== undefined) out.conveyance_allowance = s.conveyance_allowance;
    if (s.other_allowance !== undefined) out.other_allowance = s.other_allowance;
    if (s.salary_effective_date !== undefined) out.salary_effective_date = s.salary_effective_date;
    if (s.tax_exemption_status !== undefined) out.tax_exemption_status = s.tax_exemption_status;
    if (s.eobi_applicable !== undefined) out.eobi_applicable = s.eobi_applicable;
  }

  return { patch: out, department_id, designation_id, employee_type_id, role_id, access_role_id, line_managers };
}

module.exports = {
  firstOrSelf,
  serializeRowId,
  parseDocumentsArray,
  parseDependantIdsArray,
  parseEmployeeBankId,
  parseEmployeeBankPayload,
  validateAttendanceSchedulePayload,
  attendanceValidatedRowToResponse,
  resolveDepartmentName,
  resolveDesignationName,
  resolveEmployeeTypeId,
  resolveRoleId,
  resolveAccessRoleId,
  upsertAttendanceProfile,
  replaceEmployeeDocuments,
  saveEmployeeDependantIds,
  fetchDependantsForEmployee,
  validateEmployeeBankBelongsToEmployee,
  upsertEmployeeBankDetails,
  fetchBankDetailsForEmployee,
  ensureEmployeeProfileSchema,
  buildNestedEmployeePayload,
  fetchOfficialInfoByEmployeeId,
  fetchFullEmployeeProfileDetails,
  deriveEmployeeStatusFromUser,
  flattenNestedPatchForUpdate,
};
