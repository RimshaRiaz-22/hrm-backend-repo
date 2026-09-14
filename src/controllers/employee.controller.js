const pool = require('../db');
const { toUtcIsoString, utcNowForPgTimestamp, normalizeRecordDateFields, parseOptionalDateInput } = require('../utils/dateTime');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { USER_ROLES } = require('../constants/userRoles');
const { sendEmployeeTemporaryCredentialsEmail, sendEmployeeStatusUpdatedEmail, sendEmployeeDepartmentAssignedEmail, sendProfileUpdatedEmail } = require('../services/email.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parsePagination, buildPaginationMeta } = require('../utils/pagination');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { requireE164 } = require('../utils/phoneValidation');
const { validateCurrency } = require('../utils/currencyValidation');
const employeeNested = require('../services/employeeNested.service');
const lineManagerService = require('../services/lineManager.service');
const { grantActivePolicyBalancesForEmployee } = require('../services/leaveBalance.service');
const { recalculateEmployeeLeaveCycles, toDateOnlyString } = require('../services/leaveCycle.service');
const pfBalanceService = require('../services/pfBalance.service');
const { getEmployeeIdFromAuth, getEmployeeCompanyId } = require('../utils/employeeAuth');

const EMPLOYEE_DATE_FIELDS = [
  'dob',
  'national_id_expiry',
  'passport_expiry',
  'hire_date',
  'joining_date',
  'probation_end_date',
  'contract_end_date',
  'salary_effective_date',
];

const EMPLOYEE_GENDER_FILTERS = new Set(['male', 'female', 'other']);
/** Accepts ABC001 / ABC-001 — capital letter prefix, optional hyphen, then digits. */
const EMPLOYEE_CODE_REGEX = /^[A-Z]+-?\d+$/;

function normalizeEmployeeDates(data) {
  return normalizeRecordDateFields(data, EMPLOYEE_DATE_FIELDS);
}

function assertFutureCalendarDate(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const parsed = parseOptionalDateInput(value, fieldName);
  if (parsed.error) return parsed.error;
  const ymd = String(parsed.value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return `${fieldName} must be a valid date (YYYY-MM-DD).`;
  }
  const now = new Date();
  const todayYmd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  if (ymd <= todayYmd) {
    return `${fieldName} must be a future date.`;
  }
  return null;
}
const EMPLOYEE_SORT_FIELDS = new Map([
  ['id', 'e.id'],
  ['first_name', 'e.first_name'],
  ['last_name', 'e.last_name'],
  ['name', "CONCAT(e.first_name, ' ', e.last_name)"],
  ['email', 'e.work_email'],
  ['work_email', 'e.work_email'],
  ['employee_code', 'e.employee_code'],
  ['gender', 'e.gender'],
  ['created_at', 'e.created_at'],
  ['department', 'ejd.department'],
  ['designation', 'ejd.designation'],
  ['shift', 's.name'],
  ['work_location', 'wl.name'],
  ['status', 'u.is_active'],
]);

function parseOptionalPositiveIntQuery(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `${fieldName} must be a positive integer.` };
  }
  return { value: n };
}

async function lookupCompanyDepartmentName(companyId, departmentId) {
  const result = await pool.query(
    `SELECT name FROM departments WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [departmentId, companyId]
  );
  const name = result.rows[0]?.name;
  return name ? String(name).trim() : null;
}

async function lookupCompanyDesignationName(companyId, designationId) {
  const result = await pool.query(
    `SELECT name FROM designations WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [designationId, companyId]
  );
  const name = result.rows[0]?.name;
  return name ? String(name).trim() : null;
}

function appendJobDetailIdOrNameFilter(whereClauses, queryParams, idValue, nameValue, idColumn, nameColumn) {
  queryParams.push(idValue);
  const idParam = queryParams.length;
  if (nameValue) {
    queryParams.push(nameValue);
    const nameParam = queryParams.length;
    whereClauses.push(
      `(ejd.${idColumn} = $${idParam} OR LOWER(TRIM(ejd.${nameColumn})) = LOWER(TRIM($${nameParam})))`
    );
    return;
  }
  whereClauses.push(`ejd.${idColumn} = $${idParam}`);
}

function parseEmployeeSort(query = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'id').trim();
  const sortBy = EMPLOYEE_SORT_FIELDS.get(sortByRaw);
  if (!sortBy) {
    return {
      error: `sort_by must be one of: ${Array.from(EMPLOYEE_SORT_FIELDS.keys()).join(', ')}.`,
    };
  }

  const sortOrder = String(query.sort_order || query.sortOrder || 'desc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) {
    return { error: 'sort_order must be asc or desc.' };
  }

  return {
    sort_by: sortByRaw,
    sort_order: sortOrder,
    orderBySql: `${sortBy} ${sortOrder.toUpperCase()} NULLS LAST, e.id DESC`,
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;
const EMPLOYEE_ALLOWED_STATUSES = new Set(['active', 'inactive']);
const MARITAL_STATUSES = new Set(['Single', 'Married', 'Divorced', 'Widowed', 'Separated']);
const MARITAL_STATUS_BY_LOWER = new Map(
  Array.from(MARITAL_STATUSES).map((status) => [status.toLowerCase(), status])
);

function generateTemporaryPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%';
  const required = ['A', 'a', '2', '@'];
  const random = Array.from(crypto.randomBytes(4), (byte) => chars[byte % chars.length]);
  return [...required, ...random]
    .sort(() => crypto.randomInt(0, 3) - 1)
    .join('');
}

const EMPLOYEE_UPDATABLE_FIELDS = [
  'gender',
  'profile_picture_url',
  'employee_id',
  'first_name',
  'last_name',
  'father_name',
  'mother_name',
  'blood_group',
  'qualification',
  'dob',
  'marital_status',
  'religion',
  'employee_code',
  'attendance_machine_code',
  'national_id',
  'national_id_expiry',
  'passport_no',
  'passport_expiry',
  'eobi_number',
  'ntn_no',
  'country',
  'state_province',
  'city',
  'zip_postal_code',
  'nationality',
  'permanent_address',
  'temporary_address',
  'personal_email',
  'home_phone',
  'work_phone_mobile',
  'emergency_contact_name',
  'emergency_contact_no',
];

const EMPLOYEE_OFFICIAL_UPDATABLE_FIELDS = [
  'designation',
  'department',
  'department_id',
  'designation_id',
  'employee_type_id',
  'role_id',
  'shift_id',
  'work_location_id',
  'location',
  'hire_date',
  'joining_date',
  'probation_end_date',
  'contract_end_date',
  'salary',
  'salary_type',
  'currency',
  'medical_allowance',
  'conveyance_allowance',
  'other_allowance',
  'salary_effective_date',
  'tax_exemption_status',
  'eobi_applicable',
  'line_manager_id',
];

/** Columns that exist on employee_job_details (including FK ids). */
const EMPLOYEE_JOB_DETAILS_DB_COLUMNS = new Set([
  'designation',
  'department',
  'department_id',
  'designation_id',
  'employee_type_id',
  'role_id',
  'shift_id',
  'work_location_id',
  'location',
  'hire_date',
  'joining_date',
  'probation_end_date',
  'contract_end_date',
  'salary',
  'salary_type',
  'currency',
  'medical_allowance',
  'conveyance_allowance',
  'other_allowance',
  'salary_effective_date',
  'tax_exemption_status',
  'eobi_applicable',
  'line_manager_id',
]);

const EMPLOYEE_SELECT_FIELDS = `
  id, gender, profile_picture_url, employee_id, work_email, first_name, last_name, father_name, mother_name,
  blood_group, qualification, dob, marital_status, religion, employee_code, attendance_machine_code,
  national_id, national_id_expiry, passport_no, passport_expiry, eobi_number, ntn_no,
  country, state_province, city, zip_postal_code, nationality, permanent_address, temporary_address,
  personal_email, home_phone, work_phone_mobile, emergency_contact_name, emergency_contact_no, created_at,
  onboarding_status
`;

const EMPLOYEE_SELECT_FIELDS_ALIASED = EMPLOYEE_SELECT_FIELDS.split(',')
  .map((field) => field.trim())
  .filter(Boolean)
  .map((field) => `e.${field}`)
  .join(', ');

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
  lm.work_email AS line_manager_email
`;

const OFFICIAL_INFO_SELECT_FIELDS_ALIASED = `
  ejd.id AS official_info_id,
  ejd.designation AS official_info_designation,
  ejd.department AS official_info_department,
  ejd.department_id AS official_info_department_id,
  ejd.designation_id AS official_info_designation_id,
  ejd.employee_type_id AS official_info_employee_type_id,
  et.label AS official_info_employee_type_label,
  et.value AS official_info_employee_type_value,
  ejd.role_id AS official_info_role_id,
  er.label AS official_info_role_label,
  er.value AS official_info_role_value,
  ejd.shift_id AS official_info_shift_id,
  s.name AS official_info_shift_name,
  s.start_time AS official_info_shift_start_time,
  s.end_time AS official_info_shift_end_time,
  s.break_start_time AS official_info_shift_break_start_time,
  s.break_end_time AS official_info_shift_break_end_time,
  s.working_days AS official_info_shift_working_days,
  s.exclude_break_from_working_hours AS official_info_shift_exclude_break_from_working_hours,
  s.working_hours_threshold_minutes AS official_info_shift_working_hours_threshold_minutes,
  s.is_active AS official_info_shift_is_active,
  s.created_at AS official_info_shift_created_at,
  s.updated_at AS official_info_shift_updated_at,
  ejd.work_location_id AS official_info_work_location_id,
  wl.name AS official_info_work_location_name,
  wl.country AS official_info_work_location_country,
  wl.city AS official_info_work_location_city,
  wl.postal_code AS official_info_work_location_postal_code,
  wl.address AS official_info_work_location_address,
  wl.latitude AS official_info_work_location_latitude,
  wl.longitude AS official_info_work_location_longitude,
  wl.radius_meters AS official_info_work_location_radius_meters,
  wl.geofencing_enabled AS official_info_work_location_geofencing_enabled,
  ejd.location AS official_info_location,
  ejd.hire_date AS official_info_hire_date,
  ejd.joining_date AS official_info_joining_date,
  ejd.probation_end_date AS official_info_probation_end_date,
  ejd.contract_end_date AS official_info_contract_end_date,
  ejd.salary AS official_info_salary,
  ejd.salary_type AS official_info_salary_type,
  ejd.currency AS official_info_currency,
  ejd.medical_allowance AS official_info_medical_allowance,
  ejd.conveyance_allowance AS official_info_conveyance_allowance,
  ejd.other_allowance AS official_info_other_allowance,
  ejd.salary_effective_date AS official_info_salary_effective_date,
  ejd.tax_exemption_status AS official_info_tax_exemption_status,
  ejd.eobi_applicable AS official_info_eobi_applicable,
  ejd.line_manager_id AS official_info_line_manager_id,
  NULLIF(TRIM(CONCAT(COALESCE(lm.first_name, ''), ' ', COALESCE(lm.last_name, ''))), '') AS official_info_line_manager_name,
  lm.employee_code AS official_info_line_manager_employee_no,
  lm.work_email AS official_info_line_manager_email,
  ejd.access_role_id AS official_info_staged_access_role_id,
  sar.name AS official_info_staged_access_role_name
`;

function normalizeOptionalStringValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return String(value).trim();
}

function normalizeOptionalNumberValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value === 'object') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOptionalBooleanValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return value;
}

function normalizeOptionalCurrencyValue(value) {
  const result = validateCurrency(value, { required: false });
  if (!result.valid) {
    return { error: result.error || 'Unsupported currency. Please select a valid currency.' };
  }
  return { value: result.value };
}

function normalizeMaritalStatus(value) {
  const status = normalizeOptionalStringValue(value);
  if (!status) return null;
  return MARITAL_STATUS_BY_LOWER.get(status.toLowerCase()) || status;
}

function getDuplicateValueMessage(error) {
  if (!error || error.code !== '23505') return 'Duplicate value found for a unique field.';
  const detail = String(error.detail || '');
  const match = detail.match(/Key \(([^)]+)\)=\(([^)]+)\) already exists\./i);
  if (match) {
    return `${match[1]} "${match[2]}" already exists.`;
  }
  if (error.constraint) {
    return `Duplicate value found for unique constraint "${error.constraint}".`;
  }
  return 'Duplicate value found for a unique field.';
}

function buildOfficialManagersInput(officialObj = {}, flatBody = {}) {
  const merged = { ...officialObj };
  if (
    Object.prototype.hasOwnProperty.call(flatBody, 'line_manager_id') &&
    !Object.prototype.hasOwnProperty.call(merged, 'line_managers') &&
    !Object.prototype.hasOwnProperty.call(merged, 'line_manager_id')
  ) {
    merged.line_manager_id = flatBody.line_manager_id;
  }
  return merged;
}

async function loadEmployeeManagerAssignments(client, companyId, employeeId) {
  const payload = await lineManagerService.loadEmployeeLineManagersByEmployeeId(
    client,
    companyId,
    employeeId
  );
  return (payload.line_managers || []).map((manager) => ({
    managerId: Number(manager.id),
    role: manager.role,
  }));
}

function normalizePayload(body) {
  body = body || {};
  const general = body.general || {};
  const hasPersonalKey = Object.prototype.hasOwnProperty.call(body, 'personal');
  const personalObj = employeeNested.firstOrSelf(body.personal);
  const personalSource = hasPersonalKey ? personalObj : general;
  const officialObj = employeeNested.firstOrSelf(body.official);
  const attendanceScheduleObj = employeeNested.firstOrSelf(
    body.attendance_schedule ?? body.attendanceSchedule
  );
  const salaryObj = body.salary || {};

  return {
    first_name: personalSource.first_name ?? general.first_name ?? body.first_name,
    last_name: personalSource.last_name ?? general.last_name ?? body.last_name,
    email:
      body.email ??
      personalObj.work_email ??
      personalObj.email ??
      general.email ??
      body.work_email,
    gender: personalSource.gender ?? general.gender ?? body.gender,
    profile_picture_url:
      (hasPersonalKey ? personalObj.profile_image ?? personalObj.profile_picture_url : undefined) ??
      general.profile_image ??
      general.profile_picture_url ??
      body.profile_picture_url,
    dob: personalSource.dob ?? personalSource.date_of_birth ?? general.dob ?? general.date_of_birth ?? body.dob,
    country: personalSource.country ?? general.country ?? body.country,
    home_phone:
      personalSource.phone_no ??
      personalSource.phone_number ??
      general.phone_number ??
      general.home_phone ??
      body.phone_number ??
      body.home_phone,
    work_phone_mobile:
      personalSource.work_phone_mobile ??
      general.business_phone_number ??
      general.work_phone_mobile ??
      body.business_phone_number ??
      body.work_phone_mobile,
    temporary_address:
      personalSource.current_address ??
      personalSource.temporary_address ??
      general.current_address ??
      general.temporary_address ??
      body.current_address ??
      body.temporary_address,
    permanent_address: personalSource.permanent_address ?? general.permanent_address ?? body.permanent_address,
    marital_status: personalSource.marital_status ?? general.marital_status ?? body.marital_status,
    employee_code:
      personalSource.employee_code ?? general.employee_code ?? body.employee_code,
    religion: personalSource.religion ?? general.religion ?? body.religion,
    national_id:
      personalSource.cnic ??
      personalSource.national_id ??
      general.cnic ??
      general.national_id ??
      body.cnic ??
      body.national_id,
    national_id_expiry:
      personalSource.cnic_expiry ??
      personalSource.cnic_expiry_date ??
      personalSource.national_id_expiry ??
      general.cnic_expiry ??
      general.cnic_expiry_date ??
      general.national_id_expiry ??
      body.cnic_expiry ??
      body.national_id_expiry,
    designation: officialObj.designation ?? body.designation,
    department: officialObj.department ?? body.department,
    department_id: officialObj.department_id,
    designation_id: officialObj.designation_id,
    employee_type_id: officialObj.employee_type_id ?? body.employee_type_id,
    role_id: officialObj.role_id ?? body.role_id,
    access_role_id: officialObj.access_role_id ?? body.access_role_id,
    shift_id: officialObj.shift_id ?? attendanceScheduleObj.shift_id ?? body.shift_id,
    work_location_id:
      officialObj.work_location_id ?? attendanceScheduleObj.work_location_id ?? body.work_location_id,
    location: officialObj.office_location ?? officialObj.location ?? body.location,
    hire_date: officialObj.hire_date ?? body.hire_date ?? null,
    joining_date: officialObj.joining_date ?? body.joining_date ?? null,
    probation_end_date: officialObj.probation_end_date ?? body.probation_end_date ?? null,
    contract_end_date: officialObj.contract_end_date ?? body.contract_end_date ?? null,
    salary:
      salaryObj.amount ??
      salaryObj.salary ??
      (body.salary != null && typeof body.salary !== 'object' ? body.salary : undefined),
    salary_type: salaryObj.salary_type ?? body.salary_type,
    currency: salaryObj.currency ?? body.currency,
    medical_allowance: salaryObj.medical_allowance ?? body.medical_allowance,
    conveyance_allowance: salaryObj.conveyance_allowance ?? body.conveyance_allowance,
    other_allowance: salaryObj.other_allowance ?? body.other_allowance,
    salary_effective_date: salaryObj.salary_effective_date ?? body.salary_effective_date ?? null,
    tax_exemption_status: salaryObj.tax_exemption_status ?? body.tax_exemption_status,
    eobi_applicable: salaryObj.eobi_applicable ?? body.eobi_applicable,
    line_manager_id: Object.prototype.hasOwnProperty.call(officialObj, 'line_manager_id')
      ? officialObj.line_manager_id
      : Object.prototype.hasOwnProperty.call(body, 'line_manager_id')
        ? body.line_manager_id
        : undefined,
    attendance_schedule: body.attendance_schedule ?? body.attendanceSchedule ?? null,
    documents: employeeNested.parseDocumentsArray(body.documents),
    dependant_ids: employeeNested.parseDependantIdsArray(body.dependants),
    employee_bank_id: employeeNested.parseEmployeeBankId(
      body.employee_bank ?? body.employeeBank ?? body.bank_details ?? body.employee_bank_details
    ),
    employee_bank:
      body.employee_bank ?? body.employeeBank ?? body.bank_details ?? body.employee_bank_details ?? null,
    has_employee_bank:
      Object.prototype.hasOwnProperty.call(body, 'employee_bank') ||
      Object.prototype.hasOwnProperty.call(body, 'employeeBank') ||
      Object.prototype.hasOwnProperty.call(body, 'bank_details') ||
      Object.prototype.hasOwnProperty.call(body, 'employee_bank_details'),
    temporary_password:
      body.temporary_password ??
      body.password ??
      personalObj.password ??
      personalObj.temporary_password ??
      general.password ??
      null,
  };
}

function resolvePasswordFromBody(body) {
  const source = body || {};
  const personalObj = employeeNested.firstOrSelf(source.personal);
  const value =
    source.temporary_password ??
    source.password ??
    personalObj.password ??
    personalObj.temporary_password ??
    null;
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function validateEmployeePassword(password) {
  if (!password) return null;
  if (!PASSWORD_REGEX.test(password)) {
    return 'Password must be at least 8 characters and include uppercase, lowercase, and a special character.';
  }
  return null;
}

async function getAuthCompanyAdmin(authUser) {
  const result = await pool.query(
    `SELECT id, company_id, email, role, is_active FROM users WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
}

/**
 * Resolves who is calling the employee CRUD endpoints and how their access should be scoped:
 * - An active Company Admin gets `{ mode: 'company', companyId }` — the whole company, as before.
 * - Anyone else with a linked employee profile gets `{ mode: 'team', companyId, managerEmployeeId }`
 *   — callers in this mode may only act on their own direct reports (employee_line_managers
 *   rows where they are `manager_id`); route-level `protect('employees', action)` already
 *   confirms they hold the relevant permission bit before this ever runs.
 */
async function resolveEmployeeAccessScope(authUser) {
  const admin = await getAuthCompanyAdmin(authUser);
  if (admin && admin.role === USER_ROLES.COMPANY_ADMIN && admin.is_active && admin.company_id) {
    return { mode: 'company', companyId: admin.company_id };
  }

  const managerEmployeeId = await getEmployeeIdFromAuth(authUser);
  if (!managerEmployeeId) {
    return { error: 'No employee profile linked to this user.' };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: 'Employee company not found.' };
  }
  return { mode: 'team', companyId, managerEmployeeId };
}

async function isDirectReportOf(companyId, managerEmployeeId, targetEmployeeId) {
  const result = await pool.query(
    `SELECT 1 FROM employee_line_managers
     WHERE company_id = $1 AND manager_id = $2 AND employee_id = $3
     LIMIT 1`,
    [companyId, managerEmployeeId, targetEmployeeId]
  );
  return result.rowCount > 0;
}

async function getOfficialInfoByEmployeeId(db, employeeId) {
  const result = await db.query(
    `SELECT ${OFFICIAL_INFO_SELECT_FIELDS}
     FROM employee_job_details ejd
     LEFT JOIN shifts s ON s.id = ejd.shift_id
     LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
     LEFT JOIN employee_types et ON et.id = ejd.employee_type_id
     LEFT JOIN employee_roles er ON er.id = ejd.role_id
     LEFT JOIN employees lm ON lm.id = ejd.line_manager_id
     WHERE ejd.employee_id = $1`,
    [employeeId]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return row;
}

async function getEmployeeUserRow(db, employeeId, companyId) {
  const result = await db.query(
    `SELECT u.id, u.is_active, u.is_email_verified, u.signup_type, u.access_role_id, ar.name AS access_role_name
     FROM users u
     LEFT JOIN access_roles ar ON ar.id = u.access_role_id
     WHERE u.employee_id = $1 AND u.company_id = $2`,
    [employeeId, companyId]
  );
  return result.rows[0] || null;
}

function deriveEmployeeStatus(userRow) {
  if (!userRow) return null;
  // Employees still going through the Invite Employee onboarding flow have no
  // `users` row yet — surface their onboarding_status instead of falling
  // through to the invite/active/inactive logic below.
  if (userRow.onboarding_status === 'pending_invite' || userRow.onboarding_status === 'pre_boarding') {
    return userRow.onboarding_status;
  }
  if (userRow.is_active === true) {
    return 'active';
  }
  if (userRow.signup_type === 'invite') {
    return 'pending';
  }
  return 'inactive';
}

function getDepartmentAssignmentKeyFromOfficial(row) {
  if (!row) return '';
  const id = row.department_id;
  if (id != null && Number.isInteger(Number(id)) && Number(id) > 0) {
    return `id:${Number(id)}`;
  }
  const name = String(row.department || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

async function notifyEmployeeDepartmentAssignment({ employee, companyId, departmentName }) {
  const trimmedDepartment = String(departmentName || '').trim();
  if (!trimmedDepartment) return;

  try {
    const userResult = await pool.query(
      `SELECT email FROM users WHERE employee_id = $1 AND company_id = $2`,
      [employee.id, companyId]
    );
    const user = userResult.rows[0];
    if (!user?.email) {
      console.error(`Employee department assignment email skipped: no email for employee ${employee.id}`);
      return;
    }

    const emailResult = await sendEmployeeDepartmentAssignedEmail(user.email, {
      companyId,
      employeeName:
        employee.full_name ||
        `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
      departmentName: trimmedDepartment,
    });
    if (!emailResult?.sent) {
      console.error(
        `Employee department assignment email not sent for ${user.email}: ${emailResult?.reason || 'unknown error'}`
      );
    }
  } catch (mailError) {
    console.error('Employee department assignment email error:', mailError);
  }
}

async function notifyEmployeeProfileUpdated({ employee, companyId }) {
  try {
    const userResult = await pool.query(
      `SELECT email FROM users WHERE employee_id = $1 AND company_id = $2`,
      [employee.id, companyId]
    );
    const user = userResult.rows[0];
    if (!user?.email) {
      console.error(`Employee profile updated email skipped: no email for employee ${employee.id}`);
      return;
    }

    const emailResult = await sendProfileUpdatedEmail(user.email, {
      companyId,
    });
    if (!emailResult?.sent) {
      console.error(
        `Employee profile updated email not sent for ${user.email}: ${emailResult?.reason || 'unknown error'}`
      );
    }
  } catch (mailError) {
    console.error('Employee profile updated email error:', mailError);
  }
}

function employeeShiftMinutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function employeeShiftDurationMinutes(start, end) {
  const startMinutes = employeeShiftMinutesFromTime(start);
  const endMinutes = employeeShiftMinutesFromTime(end);
  if (startMinutes === null || endMinutes === null) return 0;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
}

function buildEmployeeListShift(row) {
  if (!row.official_info_shift_id) return null;
  const grossShiftMinutes = employeeShiftDurationMinutes(
    row.official_info_shift_start_time,
    row.official_info_shift_end_time
  );
  const breakDurationMinutes =
    row.official_info_shift_break_start_time && row.official_info_shift_break_end_time
      ? employeeShiftDurationMinutes(
          row.official_info_shift_break_start_time,
          row.official_info_shift_break_end_time
        )
      : 0;
  const excludeBreak = Boolean(row.official_info_shift_exclude_break_from_working_hours);
  const scheduledWorkMinutes = excludeBreak
    ? Math.max(grossShiftMinutes - breakDurationMinutes, 0)
    : grossShiftMinutes;

  return {
    id: row.official_info_shift_id,
    name: row.official_info_shift_name,
    start_time: row.official_info_shift_start_time,
    end_time: row.official_info_shift_end_time,
    break_start_time: row.official_info_shift_break_start_time,
    break_end_time: row.official_info_shift_break_end_time,
    working_days: Array.isArray(row.official_info_shift_working_days)
      ? row.official_info_shift_working_days
      : [],
    exclude_break_from_working_hours: excludeBreak,
    working_hours_threshold_minutes: Number(row.official_info_shift_working_hours_threshold_minutes ?? 0),
    gross_shift_minutes: grossShiftMinutes,
    gross_shift_hours: Number((grossShiftMinutes / 60).toFixed(2)),
    break_duration_minutes: breakDurationMinutes,
    break_duration_hours: Number((breakDurationMinutes / 60).toFixed(2)),
    scheduled_work_minutes: scheduledWorkMinutes,
    scheduled_work_hours: Number((scheduledWorkMinutes / 60).toFixed(2)),
    is_active: Boolean(row.official_info_shift_is_active),
    created_at: toUtcIsoString(row.official_info_shift_created_at),
    updated_at: toUtcIsoString(row.official_info_shift_updated_at),
  };
}

let employeeProfileSchemaEnsured = false;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const poolSize = Math.min(Math.max(limit, 1), items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  return results;
}

function invokeAddEmployee(authUser, body, bulkAdmin = null) {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req = { authUser, body, _bulkAdmin: bulkAdmin };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode, payload });
      },
    };
    Promise.resolve()
      .then(() => addEmployee(req, res))
      .catch((err) => {
        resolve({
          statusCode: 500,
          payload: { error: true, message: err?.message || 'Something went wrong while adding employee.' },
        });
      });
  });
}

async function addEmployee(req, res) {
  const body = req.body || {};
  const dateNormalized = normalizeEmployeeDates(normalizePayload(body));
  if (dateNormalized.error) {
    return sendError(res, 400, dateNormalized.error);
  }
  const data = dateNormalized.value;
  const cnicExpiryError = assertFutureCalendarDate(
    data.national_id_expiry,
    'national_id_expiry'
  );
  if (cnicExpiryError) {
    return sendError(res, 400, cnicExpiryError);
  }
  const firstName = String(data.first_name || '').trim();
  const lastName = String(data.last_name || '').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const country = String(data.country || '').trim();
  const employeeCode = String(data.employee_code || '').trim();
  // Bulk Excel import sets this so we skip slow welcome-email + heavy nested
  // response work. Account + temp password are still created normally.
  const skipCredentialsEmail = Boolean(
    body.skip_credentials_email || body.bulk_import || data.skip_credentials_email || data.bulk_import
  );

  if (!firstName || !lastName || !email || !country) {
    return sendError(res, 400, 'Please provide first_name, last_name, email, and country.');
  }
  if (firstName.length < 2) {
    return sendError(res, 400, 'first_name must be at least 2 characters.');
  }
  if (lastName.length < 2) {
    return sendError(res, 400, 'last_name must be at least 2 characters.');
  }
  if (!/^[A-Za-z]+$/.test(firstName)) {
    return sendError(res, 400, 'first_name can only contain alphabetic characters.');
  }
  if (!/^[A-Za-z]+$/.test(lastName)) {
    return sendError(res, 400, 'last_name can only contain alphabetic characters.');
  }
  if (!employeeCode) {
    return sendError(res, 400, 'employee_code is required.');
  }
  if (employeeCode.length > 50) {
    return sendError(res, 400, 'employee_code must be at most 50 characters.');
  }
  // Employee code format restriction disabled — any value is accepted.
  // if (!EMPLOYEE_CODE_REGEX.test(employeeCode)) {
  //   return sendError(res, 400, 'employee_code must use the format ABC001 or ABC-001 (capital letters).');
  // }
  if (!EMAIL_REGEX.test(email)) {
    return sendError(res, 400, 'Please provide a valid employee email.');
  }
  const requestedPassword =
    data.temporary_password !== undefined &&
    data.temporary_password !== null &&
    String(data.temporary_password).trim() !== ''
      ? String(data.temporary_password).trim()
      : null;
  const earlyPasswordValidationError = validateEmployeePassword(requestedPassword);
  if (earlyPasswordValidationError) {
    return sendError(res, 400, earlyPasswordValidationError);
  }
  const maritalStatus = normalizeMaritalStatus(data.marital_status);
  if (maritalStatus && !MARITAL_STATUSES.has(maritalStatus)) {
    return sendError(res, 400, 'marital_status must be one of: Single, Married, Divorced, Widowed, Separated.');
  }
  const bankPayload = employeeNested.parseEmployeeBankPayload(data.employee_bank);
  if (!bankPayload.ok) {
    return sendError(res, 400, bankPayload.message);
  }
  if (data.has_employee_bank && !bankPayload.value && data.employee_bank_id === null) {
    return sendError(
      res,
      400,
      'employee_bank must include bank_name, account_title, and account_number, or a valid id.'
    );
  }

  let shiftId = null;
  if (data.shift_id !== undefined && data.shift_id !== null && String(data.shift_id).trim() !== '') {
    shiftId = Number(data.shift_id);
    if (!Number.isInteger(shiftId) || shiftId <= 0) {
      return sendError(res, 400, 'shift_id must be a positive integer.');
    }
  }

  let workLocationId = null;
  if (
    data.work_location_id !== undefined &&
    data.work_location_id !== null &&
    String(data.work_location_id).trim() !== ''
  ) {
    workLocationId = Number(data.work_location_id);
    if (!Number.isInteger(workLocationId) || workLocationId <= 0) {
      return sendError(res, 400, 'work_location_id must be a positive integer.');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ALTER TABLE IF NOT EXISTS is expensive under concurrency — only run once per process.
    if (!employeeProfileSchemaEnsured) {
      await employeeNested.ensureEmployeeProfileSchema(client);
      employeeProfileSchemaEnsured = true;
    }

    const scope = req._bulkAdmin
      ? { mode: 'company', companyId: req._bulkAdmin.company_id }
      : await resolveEmployeeAccessScope(req.authUser);
    if (scope.error) {
      await client.query('ROLLBACK');
      return sendError(res, 401, scope.error);
    }
    const admin = { company_id: scope.companyId };

    if (shiftId) {
      const shiftResult = await client.query(
        `SELECT id FROM shifts WHERE id = $1 AND company_id = $2`,
        [shiftId, admin.company_id]
      );
      if (shiftResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Shift not found for this company.');
      }
    }

    if (workLocationId) {
      const locationResult = await client.query(
        `SELECT id FROM attendance_location_settings WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [workLocationId, admin.company_id]
      );
      if (locationResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Work location not found for this company.');
      }
    }

    const attResult = employeeNested.validateAttendanceSchedulePayload(data.attendance_schedule);
    if (!attResult.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, attResult.message);
    }

    let departmentName =
      data.department !== undefined && data.department !== null && String(data.department).trim() !== ''
        ? String(data.department).trim()
        : null;
    if (data.department_id !== undefined && data.department_id !== null && String(data.department_id).trim() !== '') {
      const dr = await employeeNested.resolveDepartmentName(client, admin.company_id, data.department_id);
      if (!dr.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, dr.message);
      }
      departmentName = dr.name;
    }

    let designationName =
      data.designation !== undefined && data.designation !== null && String(data.designation).trim() !== ''
        ? String(data.designation).trim()
        : null;
    if (data.designation_id !== undefined && data.designation_id !== null && String(data.designation_id).trim() !== '') {
      const dsr = await employeeNested.resolveDesignationName(client, admin.company_id, data.designation_id);
      if (!dsr.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, dsr.message);
      }
      designationName = dsr.name;
    }

    let resolvedEmployeeTypeId = null;
    if (data.employee_type_id !== undefined && data.employee_type_id !== null && String(data.employee_type_id).trim() !== '') {
      const etr = await employeeNested.resolveEmployeeTypeId(client, admin.company_id, data.employee_type_id);
      if (!etr.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, etr.message);
      }
      resolvedEmployeeTypeId = etr.id;
    }

    let resolvedRoleId = null;
    if (data.role_id !== undefined && data.role_id !== null && String(data.role_id).trim() !== '') {
      const rr = await employeeNested.resolveRoleId(client, admin.company_id, data.role_id);
      if (!rr.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, rr.message);
      }
      resolvedRoleId = rr.id;
    }

    let resolvedAccessRoleId = null;
    let resolvedAccessRoleName = null;
    if (
      data.access_role_id !== undefined &&
      data.access_role_id !== null &&
      String(data.access_role_id).trim() !== ''
    ) {
      const arr = await employeeNested.resolveAccessRoleId(client, admin.company_id, data.access_role_id);
      if (!arr.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, arr.message);
      }
      resolvedAccessRoleId = arr.id;
      resolvedAccessRoleName = arr.name;
    }

    let resolvedDepartmentId = null;
    if (data.department_id !== undefined && data.department_id !== null && String(data.department_id).trim() !== '') {
      resolvedDepartmentId = Number(data.department_id);
      if (!Number.isInteger(resolvedDepartmentId) || resolvedDepartmentId <= 0) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'department_id must be a positive integer.');
      }
    }

    const lineManagerParsed = lineManagerService.parseEmployeeLineManagers(
      buildOfficialManagersInput(employeeNested.firstOrSelf(req.body?.official), data)
    );
    if (lineManagerParsed.error) {
      await client.query('ROLLBACK');
      return sendError(res, 400, lineManagerParsed.error);
    }
    let managerAssignments = lineManagerParsed.omitted ? [] : lineManagerParsed.assignments || [];
    // A manager (non-company-admin) creating an employee may only assign themselves as the
    // primary line manager — otherwise a new hire could be created outside their own team.
    if (scope.mode === 'team') {
      managerAssignments = [{ managerId: scope.managerEmployeeId, role: 'primary' }];
    }
    let resolvedLineManagerId = null;

    let resolvedDesignationId = null;
    if (data.designation_id !== undefined && data.designation_id !== null && String(data.designation_id).trim() !== '') {
      resolvedDesignationId = Number(data.designation_id);
      if (!Number.isInteger(resolvedDesignationId) || resolvedDesignationId <= 0) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'designation_id must be a positive integer.');
      }
    }

    const hireDate = data.hire_date ?? data.joining_date ?? null;
    const joiningDate = data.joining_date ?? data.hire_date ?? null;
    const probationEndDate =
      data.probation_end_date !== undefined &&
      data.probation_end_date !== null &&
      String(data.probation_end_date).trim() !== ''
        ? String(data.probation_end_date).trim()
        : null;
    if (probationEndDate) {
      const hireYmd = hireDate ? String(hireDate).trim() : '';
      const joiningYmd = joiningDate ? String(joiningDate).trim() : '';
      if (hireYmd && probationEndDate === hireYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'probation_end_date cannot be the same as the hire date.');
      }
      if (joiningYmd && probationEndDate === joiningYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'probation_end_date cannot be the same as the joining date.');
      }
      if (joiningYmd && probationEndDate < joiningYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'probation_end_date cannot be earlier than the joining date.');
      }
    }
    const contractEndDate =
      data.contract_end_date !== undefined &&
      data.contract_end_date !== null &&
      String(data.contract_end_date).trim() !== ''
        ? String(data.contract_end_date).trim()
        : null;
    if (contractEndDate) {
      const hireYmd = hireDate ? String(hireDate).trim() : '';
      const joiningYmd = joiningDate ? String(joiningDate).trim() : '';
      if (hireYmd && contractEndDate === hireYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'contract_end_date cannot be the same as the hire date.');
      }
      if (joiningYmd && contractEndDate === joiningYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'contract_end_date cannot be the same as the joining date.');
      }
      if (joiningYmd && contractEndDate < joiningYmd) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'contract_end_date cannot be earlier than the joining date.');
      }
    }

    const existingUser = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existingUser.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const existingCode = await client.query(
      `SELECT id FROM employees WHERE LOWER(employee_code) = LOWER($1)`,
      [employeeCode]
    );
    if (existingCode.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An employee with this employee code already exists.');
    }
    const location = String(data.location || '').trim();
    let homePhone = null;
    if (data.home_phone !== undefined && data.home_phone !== null && String(data.home_phone).trim() !== '') {
      const phoneResult = requireE164(data.home_phone, { fieldName: 'phone number' });
      if (phoneResult.error) {
        await client.query('ROLLBACK');
        return sendError(res, 400, phoneResult.error);
      }
      homePhone = phoneResult.e164;
    }
    let workPhoneMobile = null;
    if (
      data.work_phone_mobile !== undefined &&
      data.work_phone_mobile !== null &&
      String(data.work_phone_mobile).trim() !== ''
    ) {
      const workPhoneResult = requireE164(data.work_phone_mobile, { fieldName: 'work phone' });
      if (workPhoneResult.error) {
        await client.query('ROLLBACK');
        return sendError(res, 400, workPhoneResult.error);
      }
      workPhoneMobile = workPhoneResult.e164;
    }
    const temporaryAddress =
      data.temporary_address !== undefined &&
      data.temporary_address !== null &&
      String(data.temporary_address).trim() !== ''
        ? String(data.temporary_address).trim()
        : null;
    const permanentAddress =
      data.permanent_address !== undefined &&
      data.permanent_address !== null &&
      String(data.permanent_address).trim() !== ''
        ? String(data.permanent_address).trim()
        : null;
    const religion = normalizeOptionalStringValue(data.religion);
    const nationalId = normalizeOptionalStringValue(data.national_id);
    const nationalIdExpiry = data.national_id_expiry ?? null;
    const salaryAmount = normalizeOptionalNumberValue(data.salary);
    const medicalAllowance = normalizeOptionalNumberValue(data.medical_allowance);
    const conveyanceAllowance = normalizeOptionalNumberValue(data.conveyance_allowance);
    const otherAllowance = normalizeOptionalNumberValue(data.other_allowance);
    const taxExemptionStatus = normalizeOptionalStringValue(data.tax_exemption_status);
    const eobiApplicable = normalizeOptionalBooleanValue(data.eobi_applicable);
    const currencyResult = normalizeOptionalCurrencyValue(data.currency);
    if (currencyResult?.error) {
      await client.query('ROLLBACK');
      return sendError(res, 400, currencyResult.error);
    }
    const salaryCurrency = currencyResult?.value ?? null;
    const createdAtUtc = utcNowForPgTimestamp();
    const insertedEmployee = await client.query(
      `INSERT INTO employees (
         company_id, gender, profile_picture_url, work_email, first_name, last_name,
         dob, marital_status, religion, national_id, national_id_expiry, employee_code,
         country, state_province, city, home_phone, work_phone_mobile,
         temporary_address, permanent_address, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11::date, $12, $13, $14, $15, $16, $17, $18, $19, $20::timestamp)
       RETURNING ${EMPLOYEE_SELECT_FIELDS}, company_id`,
      [
        admin.company_id,
        data.gender ?? null,
        data.profile_picture_url ?? null,
        email,
        firstName,
        lastName,
        data.dob ?? null,
        maritalStatus,
        religion,
        nationalId,
        nationalIdExpiry,
        employeeCode,
        country,
        location || 'N/A',
        location || 'N/A',
        homePhone,
        workPhoneMobile,
        temporaryAddress,
        permanentAddress,
        createdAtUtc,
      ]
    );
    const employee = insertedEmployee.rows[0];

    if (!lineManagerParsed.omitted) {
      const lmCheck = await lineManagerService.validateEmployeeLineManagersAssignment(client, {
        companyId: admin.company_id,
        employeeId: employee.id,
        departmentId: resolvedDepartmentId,
        assignments: managerAssignments,
      });
      if (!lmCheck.ok) {
        await client.query('ROLLBACK');
        return sendError(res, lmCheck.status || 400, lmCheck.message);
      }
      managerAssignments = lmCheck.assignments;
      resolvedLineManagerId = lmCheck.primaryLineManagerId ?? null;
    }

    await client.query(
      `INSERT INTO employee_job_details (
         employee_id, company_id, designation, department,
         department_id, designation_id, shift_id, work_location_id, location, hire_date, joining_date,
         probation_end_date, contract_end_date, salary, salary_type, currency, medical_allowance,
         conveyance_allowance, other_allowance, salary_effective_date, tax_exemption_status,
         eobi_applicable, employee_type_id, role_id, line_manager_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::date, $13::date, $14, $15, $16, $17, $18, $19, $20::date, $21, $22, $23, $24, $25)`,
      [
        employee.id,
        admin.company_id,
        designationName,
        departmentName,
        resolvedDepartmentId,
        resolvedDesignationId,
        shiftId,
        workLocationId,
        location || null,
        hireDate,
        joiningDate,
        data.probation_end_date,
        data.contract_end_date,
        salaryAmount,
        data.salary_type != null && String(data.salary_type).trim() !== ''
          ? String(data.salary_type).trim().toLowerCase()
          : null,
        salaryCurrency,
        medicalAllowance,
        conveyanceAllowance,
        otherAllowance,
        data.salary_effective_date,
        taxExemptionStatus,
        eobiApplicable,
        resolvedEmployeeTypeId,
        resolvedRoleId,
        resolvedLineManagerId,
      ]
    );

    // After joining/hire dates exist so anniversary leave cycles can be computed.
    await grantActivePolicyBalancesForEmployee(
      client,
      admin.company_id,
      employee.id,
      createdAtUtc,
      resolvedDepartmentId,
      resolvedDesignationId,
      joiningDate || hireDate || createdAtUtc
    );

    if (!lineManagerParsed.omitted) {
      await lineManagerService.replaceEmployeeLineManagers(client, {
        companyId: admin.company_id,
        employeeId: employee.id,
        assignments: managerAssignments,
      });
    }

    try {
      if (attResult.row) {
        await employeeNested.upsertAttendanceProfile(client, employee.id, admin.company_id, attResult.row);
      }
      await employeeNested.replaceEmployeeDocuments(client, employee.id, admin.company_id, data.documents);
      await employeeNested.saveEmployeeDependantIds(client, employee.id, admin.company_id, data.dependant_ids);
      if (bankPayload.value) {
        await employeeNested.upsertEmployeeBankDetails(client, employee.id, admin.company_id, bankPayload.value);
      } else if (data.employee_bank_id) {
        const bankCheck = await employeeNested.validateEmployeeBankBelongsToEmployee(
          client,
          employee.id,
          admin.company_id,
          data.employee_bank_id
        );
        if (!bankCheck.ok) {
          await client.query('ROLLBACK');
          return sendError(res, 400, bankCheck.message);
        }
      }
    } catch (linkErr) {
      await client.query('ROLLBACK');
      if (linkErr.message && linkErr.message.startsWith('DOCUMENT_TYPE_NOT_FOUND:')) {
        const badId = linkErr.message.split(':')[1];
        return sendError(res, 400, `Invalid document_type_id: ${badId} for this company.`);
      }
      if (linkErr.message && linkErr.message.startsWith('DEPENDANT_NOT_FOUND:')) {
        const badId = linkErr.message.split(':')[1];
        return sendError(res, 400, `Invalid dependant id: ${badId} for this company.`);
      }
      console.error('Employee nested persist error:', linkErr);
      return sendError(res, 500, 'Something went wrong while adding employee.');
    }


    let nestedPayload = null;
    if (!skipCredentialsEmail) {
      const officialInfo = await getOfficialInfoByEmployeeId(client, employee.id);
      nestedPayload = await employeeNested.buildNestedEmployeePayload(
        client,
        employee,
        officialInfo,
        admin.company_id
      );
      if (nestedPayload?.official) {
        nestedPayload.official.access_role_id = resolvedAccessRoleId;
        nestedPayload.official.access_role_name = resolvedAccessRoleName;
      }
    }

    const temporaryPassword = requestedPassword || generateTemporaryPassword();
    // Cheaper hash for bulk import — temp password is meant to be changed on first login.
    const temporaryPasswordHash = await bcrypt.hash(temporaryPassword, skipCredentialsEmail ? 4 : 10);

    const userInsert = await client.query(
      `INSERT INTO users (
         company_id, employee_id, full_name, email, password_hash, role, access_role_id, is_active, is_email_verified,
          mfa_enabled, signup_type, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, false, 'email', $8::timestamp, $8::timestamp)
        RETURNING id, email, role, access_role_id, company_id`,
      [
        admin.company_id,
        employee.id,
        `${firstName} ${lastName}`,
        email,
        temporaryPasswordHash,
        USER_ROLES.EMPLOYEE,
        resolvedAccessRoleId,
        createdAtUtc,
      ]
    );

    let emailResult = { sent: false, reason: skipCredentialsEmail ? 'Skipped for bulk import' : 'unknown error' };
    if (!skipCredentialsEmail) {
      try {
        emailResult = await sendEmployeeTemporaryCredentialsEmail(email, temporaryPassword, {
          companyId: admin.company_id,
        });
      } catch (mailError) {
        emailResult = { sent: false, reason: mailError.message };
      }
      if (!emailResult.sent) {
        console.error(`Email failed for employee credentials: ${emailResult.reason}`);
      }
    }

    const employeeStatus = deriveEmployeeStatus({
      signup_type: 'email',
      is_email_verified: true,
      is_active: true,
    });

    await client.query('COMMIT');

    if (skipCredentialsEmail) {
      return sendSuccess(res, 201, 'Employee created successfully.', {
        email: employee.work_email,
        employee_id: employee.id,
        status: employeeStatus,
        credentials_email_sent: false,
        credentials_email_error: emailResult.reason,
      });
    }

    if (departmentName) {
      await notifyEmployeeDepartmentAssignment({
        employee,
        companyId: admin.company_id,
        departmentName,
      });
    }

    return sendSuccess(res, 201, 'Employee created successfully. Temporary password sent.', {
      email: employee.work_email,
      employee_id: employee.id,
      status: employeeStatus,
      ...nestedPayload,
      credentials_email_sent: Boolean(emailResult.sent),
      credentials_email_error: emailResult.sent ? null : emailResult.reason,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error.code === '23505') {
      return sendError(res, 409, getDuplicateValueMessage(error));
    }
    console.error('Add employee error:', error);
    return sendError(res, 500, 'Something went wrong while adding employee.');
  } finally {
    client.release();
  }
}

async function bulkAddEmployees(req, res) {
  const employees = Array.isArray(req.body?.employees) ? req.body.employees : [];
  if (employees.length === 0) {
    return sendError(res, 400, 'employees array is required.');
  }
  if (employees.length > 100) {
    return sendError(res, 400, 'Maximum 100 employees per bulk request.');
  }

  const admin = await getAuthCompanyAdmin(req.authUser);
  if (!admin) {
    return sendError(res, 401, 'Authenticated company admin not found.');
  }
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return sendError(res, 403, 'Only a Company Admin can import employees.');
  }
  if (!admin.is_active || !admin.company_id) {
    return sendError(res, 400, 'Company admin account must be active and linked to a company.');
  }

  // Warm schema once for the whole batch.
  if (!employeeProfileSchemaEnsured) {
    const setupClient = await pool.connect();
    try {
      await employeeNested.ensureEmployeeProfileSchema(setupClient);
      employeeProfileSchemaEnsured = true;
    } finally {
      setupClient.release();
    }
  }

  const results = await mapWithConcurrency(employees, 20, async (employeeBody, index) => {
    const body = {
      ...(employeeBody || {}),
      skip_credentials_email: true,
      bulk_import: true,
    };
    const outcome = await invokeAddEmployee(req.authUser, body, admin);
    const ok =
      !outcome.payload?.error && outcome.statusCode >= 200 && outcome.statusCode < 300;
    return {
      index,
      ok,
      message: outcome.payload?.message || (ok ? 'Imported' : 'Failed to import.'),
      employee_id: outcome.payload?.data?.employee_id ?? null,
    };
  });

  const successCount = results.filter((r) => r.ok).length;
  return sendSuccess(res, 200, 'Bulk import finished.', {
    results,
    success_count: successCount,
    fail_count: results.length - successCount,
  });
}

async function getEmployees(req, res) {
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) {
    return sendError(res, 400, listPagination.error);
  }
  const sort = parseEmployeeSort(req.query);
  if (sort.error) {
    return sendError(res, 400, sort.error);
  }

  const search = String(req.query.search || req.query.name || '').trim();
  const statusFilter = String(req.query.status || '').trim().toLowerCase();
  const createdAtRaw = String(req.query.created_at || '').trim();
  let createdAtFilter = createdAtRaw;
  const genderFilter = String(req.query.gender || '').trim().toLowerCase();
  const allowedStatusFilters = new Set([
    'active',
    'inactive',
    'pending',
    'pending_invite',
    'pre_boarding',
  ]);

  const designationId = parseOptionalPositiveIntQuery(
    req.query.designation_id,
    'designation_id'
  );
  if (designationId.error) return sendError(res, 400, designationId.error);

  const departmentId = parseOptionalPositiveIntQuery(req.query.department_id, 'department_id');
  if (departmentId.error) return sendError(res, 400, departmentId.error);

  const roleId = parseOptionalPositiveIntQuery(req.query.role_id, 'role_id');
  if (roleId.error) return sendError(res, 400, roleId.error);

  const accessRoleId = parseOptionalPositiveIntQuery(req.query.access_role_id, 'access_role_id');
  if (accessRoleId.error) return sendError(res, 400, accessRoleId.error);

  const employeeTypeId = parseOptionalPositiveIntQuery(
    req.query.employee_type_id,
    'employee_type_id'
  );
  if (employeeTypeId.error) return sendError(res, 400, employeeTypeId.error);

  const employeeIdFromQuery =
    req.query.employee_id !== undefined && req.query.employee_id !== ''
      ? req.query.employee_id
      : req.query.id;
  const employeeId = parseOptionalPositiveIntQuery(employeeIdFromQuery, 'employee_id');
  if (employeeId.error) return sendError(res, 400, employeeId.error);

  if (statusFilter && !allowedStatusFilters.has(statusFilter)) {
    return sendError(
      res,
      400,
      'status filter must be active, inactive, pending, pending_invite, or pre_boarding.'
    );
  }
  if (createdAtFilter) {
    const createdAtParsed = parseOptionalDateInput(createdAtFilter, 'created_at');
    if (createdAtParsed.error) {
      return sendError(res, 400, createdAtParsed.error);
    }
    createdAtFilter = createdAtParsed.value;
  }
  if (genderFilter && !EMPLOYEE_GENDER_FILTERS.has(genderFilter)) {
    return sendError(res, 400, 'gender must be male, female, or other.');
  }

  try {
    const scope = await resolveEmployeeAccessScope(req.authUser);
    if (scope.error) {
      return sendError(res, 404, scope.error);
    }
    const admin = { company_id: scope.companyId };
    await employeeNested.ensureEmployeeProfileSchema(pool);

    const whereClauses = ['e.company_id = $1'];
    const queryParams = [admin.company_id];

    if (scope.mode === 'team') {
      queryParams.push(scope.managerEmployeeId);
      whereClauses.push(`EXISTS (
        SELECT 1 FROM employee_line_managers elm
        WHERE elm.company_id = e.company_id
          AND elm.employee_id = e.id
          AND elm.manager_id = $${queryParams.length}
      )`);
    }

    if (search) {
      queryParams.push(`%${search}%`);
      const searchIndex = queryParams.length;
      whereClauses.push(
        `(e.first_name ILIKE $${searchIndex} OR e.last_name ILIKE $${searchIndex} OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex})`
      );
    }

    if (employeeId.value) {
      queryParams.push(employeeId.value);
      whereClauses.push(`e.id = $${queryParams.length}`);
    }

    if (genderFilter) {
      queryParams.push(genderFilter);
      whereClauses.push(`LOWER(TRIM(e.gender)) = $${queryParams.length}`);
    }

    if (designationId.value) {
      const designationName = await lookupCompanyDesignationName(
        admin.company_id,
        designationId.value
      );
      appendJobDetailIdOrNameFilter(
        whereClauses,
        queryParams,
        designationId.value,
        designationName,
        'designation_id',
        'designation'
      );
    }

    if (departmentId.value) {
      const departmentName = await lookupCompanyDepartmentName(
        admin.company_id,
        departmentId.value
      );
      appendJobDetailIdOrNameFilter(
        whereClauses,
        queryParams,
        departmentId.value,
        departmentName,
        'department_id',
        'department'
      );
    }

    if (roleId.value) {
      queryParams.push(roleId.value);
      whereClauses.push(`ejd.role_id = $${queryParams.length}`);
    }

    if (accessRoleId.value) {
      // Same fallback as the response mapping below: an activated employee's
      // access role lives on users.access_role_id; a pending/pre-boarding
      // employee (no users row yet) has it staged on employee_job_details.
      queryParams.push(accessRoleId.value);
      whereClauses.push(`COALESCE(u.access_role_id, ejd.access_role_id) = $${queryParams.length}`);
    }

    if (employeeTypeId.value) {
      queryParams.push(employeeTypeId.value);
      whereClauses.push(`ejd.employee_type_id = $${queryParams.length}`);
    }

    if (statusFilter === 'pending') {
      whereClauses.push(`(u.signup_type = 'invite' AND u.is_active = false)`);
    } else if (statusFilter === 'active') {
      whereClauses.push(`u.is_active = true`);
    } else if (statusFilter === 'inactive') {
      whereClauses.push(
        `(u.is_active = false AND (u.signup_type IS DISTINCT FROM 'invite' OR u.signup_type IS NULL))`
      );
    } else if (statusFilter === 'pending_invite') {
      whereClauses.push(`e.onboarding_status = 'pending_invite'`);
    } else if (statusFilter === 'pre_boarding') {
      whereClauses.push(`e.onboarding_status = 'pre_boarding'`);
    }

    if (createdAtFilter) {
      queryParams.push(createdAtFilter);
      const createdAtIndex = queryParams.length;
      whereClauses.push(`e.created_at::date = $${createdAtIndex}::date`);
    }

    const whereSql = whereClauses.join(' AND ');

    const countFromSql = `
         FROM employees e
         LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
         LEFT JOIN users u ON u.employee_id = e.id AND u.company_id = e.company_id
         WHERE ${whereSql}`;

    const listFromSql = `
         FROM employees e
         LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
         LEFT JOIN shifts s ON s.id = ejd.shift_id
         LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
         LEFT JOIN employee_types et ON et.id = ejd.employee_type_id
         LEFT JOIN employee_roles er ON er.id = ejd.role_id
         LEFT JOIN employees lm ON lm.id = ejd.line_manager_id
         LEFT JOIN users u ON u.employee_id = e.id AND u.company_id = e.company_id
         LEFT JOIN access_roles uar ON uar.id = u.access_role_id
         LEFT JOIN access_roles sar ON sar.id = ejd.access_role_id
         LEFT JOIN employee_pf_balances epb ON epb.employee_id = e.id
         WHERE ${whereSql}`;

    const listParams = [...queryParams];
    let listSql = `SELECT ${EMPLOYEE_SELECT_FIELDS_ALIASED},
                ${OFFICIAL_INFO_SELECT_FIELDS_ALIASED},
                u.id AS user_id,
                u.is_active AS user_is_active,
                u.is_email_verified AS user_is_email_verified,
                u.signup_type AS user_signup_type,
                u.access_role_id AS user_access_role_id,
                uar.name AS user_access_role_name,
                COALESCE(epb.is_enrolled, FALSE) AS pf_enabled
         ${listFromSql}
         ORDER BY ${sort.orderBySql}`;

    if (!listPagination.noPagination) {
      listSql += ` LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`;
      listParams.push(listPagination.pagination.limit, listPagination.pagination.offset);
    }

    const [listResult, countResult] = await Promise.all([
      pool.query(listSql, listParams),
      pool.query(`SELECT COUNT(*)::int AS total ${countFromSql}`, queryParams),
    ]);

    const total = countResult.rows[0].total || 0;
    const employees = listResult.rows.map((row) => {
      const officialInfo = {
        id: row.official_info_id,
        designation: row.official_info_designation,
        department: row.official_info_department,
        department_id: row.official_info_department_id ?? null,
        designation_id: row.official_info_designation_id ?? null,
        employee_type_id: row.official_info_employee_type_id ?? null,
        employee_type_label: row.official_info_employee_type_label ?? null,
        employee_type_value: row.official_info_employee_type_value ?? null,
        role_id: row.official_info_role_id ?? null,
        // Fall back to the access role name (real users.access_role_id, or the staged
        // employee_job_details value pre-activation) so the list shows the same label
        // access_role_name resolves to below.
        role_label:
          row.official_info_role_label ??
          row.user_access_role_name ??
          row.official_info_staged_access_role_name ??
          null,
        role_value: row.official_info_role_value ?? null,
        // No users row yet (pending_invite/pre_boarding) — fall back to the permission role
        // staged on employee_job_details at invite time (employeeOnboarding.controller.js
        // inviteEmployee), same fallback used by GET /employees/:id.
        access_role_id:
          row.user_access_role_id != null
            ? String(row.user_access_role_id)
            : row.official_info_staged_access_role_id != null
              ? String(row.official_info_staged_access_role_id)
              : null,
        access_role_name: row.user_access_role_name ?? row.official_info_staged_access_role_name ?? null,
        shift_id: row.official_info_shift_id,
        shift_name: row.official_info_shift_name,
        shift: buildEmployeeListShift(row),
        work_location_id: row.official_info_work_location_id ?? null,
        work_location_name: row.official_info_work_location_name ?? null,
        work_location: row.official_info_work_location_id
          ? {
              id: row.official_info_work_location_id,
              name: row.official_info_work_location_name,
              country: row.official_info_work_location_country ?? null,
              city: row.official_info_work_location_city ?? null,
              postal_code: row.official_info_work_location_postal_code ?? null,
              address: row.official_info_work_location_address ?? null,
              latitude:
                row.official_info_work_location_latitude != null
                  ? Number(row.official_info_work_location_latitude)
                  : null,
              longitude:
                row.official_info_work_location_longitude != null
                  ? Number(row.official_info_work_location_longitude)
                  : null,
              radius_meters:
                row.official_info_work_location_radius_meters != null
                  ? Number(row.official_info_work_location_radius_meters)
                  : null,
              geofencing_enabled: Boolean(row.official_info_work_location_geofencing_enabled),
            }
          : null,
        location: row.official_info_location,
        hire_date: row.official_info_hire_date,
        joining_date: row.official_info_joining_date ?? row.official_info_hire_date,
        probation_end_date: row.official_info_probation_end_date,
        contract_end_date: row.official_info_contract_end_date,
        salary: row.official_info_salary,
        salary_type: row.official_info_salary_type,
        currency: row.official_info_currency ?? null,
        medical_allowance: row.official_info_medical_allowance,
        conveyance_allowance: row.official_info_conveyance_allowance,
        other_allowance: row.official_info_other_allowance,
        salary_effective_date: row.official_info_salary_effective_date,
        tax_exemption_status: row.official_info_tax_exemption_status,
        eobi_applicable: row.official_info_eobi_applicable,
        line_manager_id: row.official_info_line_manager_id ?? null,
        line_manager_name: row.official_info_line_manager_name ?? null,
        line_manager_email: row.official_info_line_manager_email ?? null,
        line_manager: row.official_info_line_manager_id
          ? {
              id: row.official_info_line_manager_id,
              name: row.official_info_line_manager_name ?? null,
              email: row.official_info_line_manager_email ?? null,
              employee_no: row.official_info_line_manager_employee_no ?? null,
            }
          : null,
      };

      const employee = {
        id: row.id,
        user_id: row.user_id != null ? Number(row.user_id) : null,
        gender: row.gender,
        profile_picture_url: row.profile_picture_url,
        employee_id: row.id,
        // Falls back to personal_email so pending-onboarding employees (no work_email
        // assigned yet) still show a usable email in the list.
        email: row.work_email || row.personal_email || null,
        work_email: row.work_email,
        first_name: row.first_name,
        last_name: row.last_name,
        father_name: row.father_name,
        mother_name: row.mother_name,
        blood_group: row.blood_group,
        qualification: row.qualification,
        dob: row.dob,
        marital_status: row.marital_status,
        religion: row.religion,
        employee_code: row.employee_code,
        attendance_machine_code: row.attendance_machine_code,
        national_id: row.national_id,
        national_id_expiry: row.national_id_expiry,
        passport_no: row.passport_no,
        passport_expiry: row.passport_expiry,
        eobi_number: row.eobi_number,
        ntn_no: row.ntn_no,
        country: row.country,
        state_province: row.state_province,
        city: row.city,
        zip_postal_code: row.zip_postal_code,
        nationality: row.nationality,
        permanent_address: row.permanent_address,
        temporary_address: row.temporary_address,
        personal_email: row.personal_email,
        home_phone: row.home_phone,
        work_phone_mobile: row.work_phone_mobile,
        emergency_contact_name: row.emergency_contact_name,
        emergency_contact_no: row.emergency_contact_no,
        created_at: toUtcIsoString(row.created_at),
      };

      return {
        ...employee,
        pf_enabled: Boolean(row.pf_enabled),
        onboarding_status: row.onboarding_status ?? 'active',
        status: deriveEmployeeStatus({
          is_active: row.user_is_active,
          is_email_verified: row.user_is_email_verified,
          signup_type: row.user_signup_type,
          onboarding_status: row.onboarding_status,
        }),
        official: officialInfo.id ? officialInfo : null,
        official_info: officialInfo.id ? officialInfo : null,
      };
    });

    return sendSuccess(res, 200, 'Employees fetched successfully.', {
      employees,
      pagination: buildListPaginationMeta(total, listPagination),
      sort: {
        sort_by: sort.sort_by,
        sort_order: sort.sort_order,
      },
    });
  } catch (error) {
    console.error('Get employees error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employees.');
  }
}

async function getEmployeeById(req, res) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid employee id.');
  }

  try {
    await employeeNested.ensureEmployeeProfileSchema(pool);

    const scope = await resolveEmployeeAccessScope(req.authUser);
    if (scope.error) {
      return sendError(res, 404, scope.error);
    }
    const admin = { company_id: scope.companyId };

    if (scope.mode === 'team' && !(await isDirectReportOf(scope.companyId, scope.managerEmployeeId, id))) {
      return sendError(res, 404, 'Employee not found.');
    }

    const result = await pool.query(
      `SELECT ${EMPLOYEE_SELECT_FIELDS}
       FROM employees
       WHERE id = $1 AND company_id = $2`,
      [id, admin.company_id]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'Employee not found.');
    }

    const employee = result.rows[0];
    const userRow = await getEmployeeUserRow(pool, employee.id, admin.company_id);
    const profileDetails = await employeeNested.fetchFullEmployeeProfileDetails(pool, {
      employeeId: employee.id,
      companyId: admin.company_id,
      userRow,
    });

    if (!profileDetails) {
      return sendError(res, 404, 'Employee not found.');
    }

    const { pf_enabled, pf_account } = await pfBalanceService.getEmployeePfDetailsForProfile(
      employee.id
    );

    return sendSuccess(res, 200, 'Employee details fetched successfully.', {
      ...profileDetails,
      pf_enabled,
      pf_account,
    });
  } catch (error) {
    console.error('Get employee by id error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee details.');
  }
}

async function updateEmployeeById(req, res) {
  const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 400, 'Please provide a valid employee id.');
    }

    const body = req.body || {};
    const {
      patch: nestedPatch,
      department_id: nestedDeptId,
      designation_id: nestedDesigId,
      employee_type_id: nestedEmpTypeId,
      role_id: nestedRoleId,
      access_role_id: nestedAccessRoleId,
      line_managers: nestedLineManagers,
    } = employeeNested.flattenNestedPatchForUpdate(body);
    const effectiveBody = { ...body, ...nestedPatch };

    if (Object.prototype.hasOwnProperty.call(effectiveBody, 'work_email')) {
      return sendError(res, 400, 'work_email is not editable.');
    }
    const normalizedStatus =
      effectiveBody.status !== undefined ? String(effectiveBody.status || '').trim().toLowerCase() : null;
    if (normalizedStatus !== null && !EMPLOYEE_ALLOWED_STATUSES.has(normalizedStatus)) {
      return sendError(res, 400, 'status must be either "active" or "inactive".');
    }
    if (effectiveBody.marital_status !== undefined) {
      const maritalStatus = normalizeMaritalStatus(effectiveBody.marital_status);
      if (maritalStatus && !MARITAL_STATUSES.has(maritalStatus)) {
        return sendError(res, 400, 'marital_status must be one of: Single, Married, Divorced, Widowed, Separated.');
      }
      effectiveBody.marital_status = maritalStatus;
    }
    if (effectiveBody.employee_code !== undefined) {
      const employeeCode = String(effectiveBody.employee_code || '').trim();
      if (!employeeCode) {
        return sendError(res, 400, 'employee_code cannot be empty.');
      }
      if (employeeCode.length > 50) {
        return sendError(res, 400, 'employee_code must be at most 50 characters.');
      }
      // Employee code format restriction disabled — any value is accepted.
      // if (!EMPLOYEE_CODE_REGEX.test(employeeCode)) {
      //   return sendError(res, 400, 'employee_code must use the format ABC001 or ABC-001 (capital letters).');
      // }
      effectiveBody.employee_code = employeeCode;
    }
    if (effectiveBody.first_name !== undefined) {
      const firstName = String(effectiveBody.first_name || '').trim();
      if (!firstName) {
        return sendError(res, 400, 'first_name cannot be empty.');
      }
      if (firstName.length < 2) {
        return sendError(res, 400, 'first_name must be at least 2 characters.');
      }
      if (!/^[A-Za-z]+$/.test(firstName)) {
        return sendError(res, 400, 'first_name can only contain alphabetic characters.');
      }
      effectiveBody.first_name = firstName;
    }
    if (effectiveBody.last_name !== undefined) {
      const lastName = String(effectiveBody.last_name || '').trim();
      if (!lastName) {
        return sendError(res, 400, 'last_name cannot be empty.');
      }
      if (lastName.length < 2) {
        return sendError(res, 400, 'last_name must be at least 2 characters.');
      }
      if (!/^[A-Za-z]+$/.test(lastName)) {
        return sendError(res, 400, 'last_name can only contain alphabetic characters.');
      }
      effectiveBody.last_name = lastName;
    }

    const employeeDates = normalizeEmployeeDates(effectiveBody);
    if (employeeDates.error) {
      return sendError(res, 400, employeeDates.error);
    }
    Object.assign(effectiveBody, employeeDates.value);
    if (Object.prototype.hasOwnProperty.call(effectiveBody, 'national_id_expiry')) {
      const cnicExpiryError = assertFutureCalendarDate(
        effectiveBody.national_id_expiry,
        'national_id_expiry'
      );
      if (cnicExpiryError) {
        return sendError(res, 400, cnicExpiryError);
      }
    }

    const requestedFields = Object.keys(effectiveBody).filter((key) => EMPLOYEE_UPDATABLE_FIELDS.includes(key));
    const normalizedBody = { ...effectiveBody };
    // Only map hire_date when the client actually sent hire_date or joining_date.
    // Always assigning hire_date: undefined made hasOwnProperty('hire_date') true on
    // status-only updates, which cleared hire_date and sent a profile-update email.
    if (effectiveBody.hire_date !== undefined) {
      normalizedBody.hire_date = effectiveBody.hire_date;
    } else if (effectiveBody.joining_date !== undefined) {
      normalizedBody.hire_date = effectiveBody.joining_date;
    }

    let requestedOfficialFields = EMPLOYEE_OFFICIAL_UPDATABLE_FIELDS.filter(
      (key) =>
        Object.prototype.hasOwnProperty.call(normalizedBody, key) &&
        normalizedBody[key] !== undefined
    );

    const hasNestedReplace =
      Object.prototype.hasOwnProperty.call(body, 'documents') ||
      Object.prototype.hasOwnProperty.call(body, 'dependants') ||
      Object.prototype.hasOwnProperty.call(body, 'attendance_schedule') ||
      Object.prototype.hasOwnProperty.call(body, 'attendanceSchedule') ||
      Object.prototype.hasOwnProperty.call(body, 'employee_bank') ||
      Object.prototype.hasOwnProperty.call(body, 'employeeBank') ||
      Object.prototype.hasOwnProperty.call(body, 'bank_details') ||
      Object.prototype.hasOwnProperty.call(body, 'employee_bank_details');

    const officialObj = employeeNested.firstOrSelf(body.official);
    const managersParsed = lineManagerService.parseEmployeeLineManagers(
      buildOfficialManagersInput(
        {
          ...officialObj,
          ...(nestedLineManagers !== undefined ? { line_managers: nestedLineManagers } : {}),
        },
        normalizedBody
      )
    );
    if (managersParsed.error) {
      return sendError(res, 400, managersParsed.error);
    }

    if (
      requestedFields.length === 0 &&
      requestedOfficialFields.length === 0 &&
      normalizedStatus === null &&
      !hasNestedReplace &&
      nestedAccessRoleId === undefined &&
      managersParsed.omitted
    ) {
      return sendError(res, 400, 'Please provide at least one valid field to update.');
    }

    const hadNonStatusProfileUpdates =
      requestedFields.length > 0 || requestedOfficialFields.length > 0 || hasNestedReplace;

    const setClause = requestedFields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    const values = requestedFields.map((field) => effectiveBody[field]);

    try {
      const scope = await resolveEmployeeAccessScope(req.authUser);
      if (scope.error) {
        return sendError(res, 404, scope.error);
      }
      const admin = { company_id: scope.companyId };

      if (scope.mode === 'team') {
        if (!(await isDirectReportOf(scope.companyId, scope.managerEmployeeId, id))) {
          return sendError(res, 404, 'Employee not found.');
        }
        // Org-structure changes (who manages this employee, which department they're in)
        // stay a Company Admin action even for a manager editing their own report.
        if (!managersParsed.omitted) {
          return sendError(res, 403, "Only a Company Admin can reassign an employee's line manager.");
        }
        if (Object.prototype.hasOwnProperty.call(normalizedBody, 'department_id')) {
          return sendError(res, 403, "Only a Company Admin can change an employee's department.");
        }
      }

      const client = await pool.connect();
      let shouldSendStatusEmail = false;
      let shouldSendDepartmentEmail = false;
      let departmentNameForEmail = null;
      let managerAssignmentsToPersist = null;
      try {
        await client.query('BEGIN');
        await employeeNested.ensureEmployeeProfileSchema(client);
        const previousOfficialInfo = await getOfficialInfoByEmployeeId(client, id);

        if (nestedDeptId !== undefined && nestedDeptId !== null && String(nestedDeptId).trim() !== '') {
          const dr = await employeeNested.resolveDepartmentName(client, admin.company_id, nestedDeptId);
          if (!dr.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, dr.message);
          }
          normalizedBody.department = dr.name;
          normalizedBody.department_id = Number(nestedDeptId);
          if (!requestedOfficialFields.includes('department')) {
            requestedOfficialFields.push('department');
          }
        }
        if (nestedDesigId !== undefined && nestedDesigId !== null && String(nestedDesigId).trim() !== '') {
          const dsr = await employeeNested.resolveDesignationName(client, admin.company_id, nestedDesigId);
          if (!dsr.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, dsr.message);
          }
          normalizedBody.designation = dsr.name;
          normalizedBody.designation_id = Number(nestedDesigId);
          if (!requestedOfficialFields.includes('designation')) {
            requestedOfficialFields.push('designation');
          }
        }
        if (nestedEmpTypeId !== undefined) {
          if (nestedEmpTypeId === null || String(nestedEmpTypeId).trim() === '') {
            normalizedBody.employee_type_id = null;
          } else {
            const etr = await employeeNested.resolveEmployeeTypeId(client, admin.company_id, nestedEmpTypeId);
            if (!etr.ok) {
              await client.query('ROLLBACK');
              return sendError(res, 400, etr.message);
            }
            normalizedBody.employee_type_id = etr.id;
          }
          if (!requestedOfficialFields.includes('employee_type_id')) {
            requestedOfficialFields.push('employee_type_id');
          }
        }
        if (nestedRoleId !== undefined) {
          if (nestedRoleId === null || String(nestedRoleId).trim() === '') {
            normalizedBody.role_id = null;
          } else {
            const rr = await employeeNested.resolveRoleId(client, admin.company_id, nestedRoleId);
            if (!rr.ok) {
              await client.query('ROLLBACK');
              return sendError(res, 400, rr.message);
            }
            normalizedBody.role_id = rr.id;
          }
          if (!requestedOfficialFields.includes('role_id')) {
            requestedOfficialFields.push('role_id');
          }
        }

        const lineManagerParsed = managersParsed;

        const previousDepartmentId =
          previousOfficialInfo?.department_id != null ? Number(previousOfficialInfo.department_id) : null;
        let nextDepartmentIdForManager = previousDepartmentId;
        if (Object.prototype.hasOwnProperty.call(normalizedBody, 'department_id')) {
          nextDepartmentIdForManager =
            normalizedBody.department_id == null || String(normalizedBody.department_id).trim() === ''
              ? null
              : Number(normalizedBody.department_id);
        }
        const departmentIdChanged = nextDepartmentIdForManager !== previousDepartmentId;

        if (!lineManagerParsed.omitted || departmentIdChanged) {
          let nextAssignments;
          if (!lineManagerParsed.omitted) {
            nextAssignments = lineManagerParsed.assignments;
          } else {
            const previousAssignments = await loadEmployeeManagerAssignments(
              client,
              admin.company_id,
              id
            );
            const eligibleManagerIds = await lineManagerService.loadEligibleManagerIdsForDepartment(
              client,
              admin.company_id,
              nextDepartmentIdForManager
            );
            const resolved = lineManagerService.resolveEmployeeManagersOnDepartmentChange({
              previousAssignments,
              managersProvided: false,
              requestedAssignments: [],
              eligibleManagerIds,
            });
            nextAssignments = resolved.assignments;
          }

          const lmCheck = await lineManagerService.validateEmployeeLineManagersAssignment(client, {
            companyId: admin.company_id,
            employeeId: id,
            departmentId: nextDepartmentIdForManager,
            assignments: nextAssignments,
          });
          if (!lmCheck.ok) {
            await client.query('ROLLBACK');
            return sendError(res, lmCheck.status || 400, lmCheck.message);
          }
          managerAssignmentsToPersist = lmCheck.assignments;
          normalizedBody.line_manager_id = lmCheck.primaryLineManagerId ?? null;
          if (!requestedOfficialFields.includes('line_manager_id')) {
            requestedOfficialFields.push('line_manager_id');
          }
        }

        requestedOfficialFields = [...new Set(requestedOfficialFields)];

        // joining_date is its own column — persist it independently from hire_date.
        requestedOfficialFields = [...new Set(requestedOfficialFields)].filter((f) =>
          EMPLOYEE_JOB_DETAILS_DB_COLUMNS.has(f)
        );

        if (Object.prototype.hasOwnProperty.call(effectiveBody, 'employee_code')) {
          const duplicateCode = await client.query(
            `SELECT id FROM employees WHERE LOWER(employee_code) = LOWER($1) AND id <> $2`,
            [effectiveBody.employee_code, id]
          );
          if (duplicateCode.rowCount > 0) {
            await client.query('ROLLBACK');
            return sendError(res, 409, 'An employee with this employee code already exists.');
          }
        }

        let employee;
        if (requestedFields.length > 0) {
          const result = await client.query(
            `UPDATE employees
            SET ${setClause}
            WHERE id = $${requestedFields.length + 1} AND company_id = $${requestedFields.length + 2}
            RETURNING ${EMPLOYEE_SELECT_FIELDS}`,
            [...values, id, admin.company_id]
          );
          if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Employee not found.');
          }
          employee = result.rows[0];
        } else {
          const employeeResult = await client.query(
            `SELECT ${EMPLOYEE_SELECT_FIELDS}
            FROM employees
            WHERE id = $1 AND company_id = $2`,
            [id, admin.company_id]
          );
          if (employeeResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Employee not found.');
          }
          employee = employeeResult.rows[0];
        }

        if (requestedOfficialFields.includes('shift_id')) {
          const incomingShiftId = normalizedBody.shift_id;
          if (incomingShiftId !== null && incomingShiftId !== undefined && String(incomingShiftId).trim() !== '') {
            const shiftId = Number(incomingShiftId);
            if (!Number.isInteger(shiftId) || shiftId <= 0) {
              await client.query('ROLLBACK');
              return sendError(res, 400, 'shift_id must be a positive integer.');
            }
            const shiftCheck = await client.query(
              `SELECT id FROM shifts WHERE id = $1 AND company_id = $2`,
              [shiftId, admin.company_id]
            );
            if (shiftCheck.rowCount === 0) {
              await client.query('ROLLBACK');
              return sendError(res, 404, 'Shift not found for this company.');
            }
          }
        }
        if (requestedOfficialFields.includes('work_location_id')) {
          const workLocationId = normalizedBody.work_location_id;
          if (workLocationId !== null && workLocationId !== undefined && String(workLocationId).trim() !== '') {
            const parsedWorkLocationId = Number(workLocationId);
            if (!Number.isInteger(parsedWorkLocationId) || parsedWorkLocationId <= 0) {
              await client.query('ROLLBACK');
              return sendError(res, 400, 'work_location_id must be a positive integer.');
            }
            const workLocationCheck = await client.query(
              `SELECT id FROM attendance_location_settings WHERE id = $1 AND company_id = $2 AND is_active = true`,
              [parsedWorkLocationId, admin.company_id]
            );
            if (workLocationCheck.rowCount === 0) {
              await client.query('ROLLBACK');
              return sendError(res, 404, 'Work location not found for this company.');
            }
          }
        }

        if (
          requestedOfficialFields.includes('department') ||
          requestedOfficialFields.includes('department_id')
        ) {
          const previousKey = getDepartmentAssignmentKeyFromOfficial(previousOfficialInfo);
          const nextDepartmentId =
            normalizedBody.department_id !== undefined
              ? normalizedBody.department_id
              : previousOfficialInfo?.department_id ?? null;
          let nextDepartmentName =
            normalizedBody.department !== undefined
              ? normalizedBody.department
              : previousOfficialInfo?.department ?? null;

          if (
            (!nextDepartmentName || !String(nextDepartmentName).trim()) &&
            nextDepartmentId != null &&
            String(nextDepartmentId).trim() !== ''
          ) {
            const nameResult = await client.query(
              `SELECT name FROM departments WHERE id = $1 AND company_id = $2`,
              [Number(nextDepartmentId), admin.company_id]
            );
            nextDepartmentName = nameResult.rows[0]?.name ?? nextDepartmentName;
          }

          const nextKey = getDepartmentAssignmentKeyFromOfficial({
            department_id: nextDepartmentId,
            department: nextDepartmentName,
          });

          if (nextKey && nextKey !== previousKey) {
            shouldSendDepartmentEmail = true;
            departmentNameForEmail = String(nextDepartmentName || '').trim();
          }
        }

        if (requestedOfficialFields.length > 0) {
          const officialValues = requestedOfficialFields.map((field) => {
            const rawValue = normalizedBody[field];
            if (field === 'shift_id') {
              if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') return null;
              return Number(rawValue);
            }
            if (
              field === 'department_id' ||
              field === 'designation_id' ||
              field === 'employee_type_id' ||
              field === 'role_id' ||
              field === 'work_location_id' ||
              field === 'line_manager_id'
            ) {
              if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') return null;
              return Number(rawValue);
            }
            if (
              field === 'salary' ||
              field === 'medical_allowance' ||
              field === 'conveyance_allowance' ||
              field === 'other_allowance'
            ) {
              return normalizeOptionalNumberValue(rawValue);
            }
            if (field === 'salary_type') {
              if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') return null;
              return String(rawValue).trim().toLowerCase();
            }
            if (field === 'tax_exemption_status') {
              return normalizeOptionalStringValue(rawValue);
            }
            if (field === 'currency') {
              const currencyResult = normalizeOptionalCurrencyValue(rawValue);
              if (currencyResult?.error) {
                throw Object.assign(new Error(currencyResult.error), { statusCode: 400 });
              }
              return currencyResult?.value ?? null;
            }
            if (field === 'eobi_applicable') {
              return normalizeOptionalBooleanValue(rawValue);
            }
            if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') return null;
            return rawValue;
          });

          const officialSetClause = requestedOfficialFields
            .map((field, index) => `${field} = $${index + 1}`)
            .join(', ');

          const updateOfficialResult = await client.query(
            `UPDATE employee_job_details
            SET ${officialSetClause}
            WHERE employee_id = $${requestedOfficialFields.length + 1}
              AND company_id = $${requestedOfficialFields.length + 2}
            RETURNING id`,
            [...officialValues, id, admin.company_id]
          );

          if (updateOfficialResult.rowCount === 0) {
            const insertColumns = ['employee_id', 'company_id', ...requestedOfficialFields];
            const insertPlaceholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
            const insertValues = [id, admin.company_id, ...officialValues];
            await client.query(
              `INSERT INTO employee_job_details (${insertColumns.join(', ')})
              VALUES (${insertPlaceholders})`,
              insertValues
            );
          }

          const anchorFieldsTouched =
            requestedOfficialFields.includes('hire_date') ||
            requestedOfficialFields.includes('joining_date') ||
            effectiveBody.joining_date !== undefined;
          if (anchorFieldsTouched) {
            const prevAnchor = toDateOnlyString(
              previousOfficialInfo?.joining_date || previousOfficialInfo?.hire_date
            );
            const nextAnchor = toDateOnlyString(
              normalizedBody.joining_date !== undefined
                ? normalizedBody.joining_date
                : normalizedBody.hire_date !== undefined
                  ? normalizedBody.hire_date
                  : prevAnchor
            );
            if (prevAnchor !== nextAnchor) {
              await recalculateEmployeeLeaveCycles(
                client,
                admin.company_id,
                id,
                utcNowForPgTimestamp(),
                nextAnchor
              );
            }
          }
        }

        if (managerAssignmentsToPersist !== null) {
          await lineManagerService.replaceEmployeeLineManagers(client, {
            companyId: admin.company_id,
            employeeId: id,
            assignments: managerAssignmentsToPersist,
          });
        }

        if (normalizedStatus !== null) {
          const existingUserRow = await getEmployeeUserRow(client, id, admin.company_id);
          if (!existingUserRow) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Employee user account not found.');
          }

          const newIsActive = normalizedStatus === 'active';
          const previousIsActive = existingUserRow.is_active === true;
          shouldSendStatusEmail = previousIsActive !== newIsActive;

          const userUpdate = await client.query(
            `UPDATE users
            SET is_active = $1,
                signup_type = CASE
                  WHEN $1 = false AND signup_type = 'invite' THEN 'email'
                  ELSE signup_type
                END,
                updated_at = NOW()
            WHERE employee_id = $2 AND company_id = $3
            RETURNING id`,
            [newIsActive, id, admin.company_id]
          );
          if (userUpdate.rowCount === 0) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Employee user account not found.');
          }
        }

        // Only touch access_role_id when a real value is provided — an empty/blank
        // value must never silently clear an employee's existing permission role.
        if (nestedAccessRoleId !== undefined && nestedAccessRoleId !== null && String(nestedAccessRoleId).trim() !== '') {
          const arr = await employeeNested.resolveAccessRoleId(client, admin.company_id, nestedAccessRoleId);
          if (!arr.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, arr.message);
          }

          const accessRoleUpdate = await client.query(
            `UPDATE users
            SET access_role_id = $1,
                updated_at = NOW()
            WHERE employee_id = $2 AND company_id = $3
            RETURNING id`,
            [arr.id, id, admin.company_id]
          );
          if (accessRoleUpdate.rowCount === 0) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Employee user account not found.');
          }
        }

        if (
          Object.prototype.hasOwnProperty.call(body, 'attendance_schedule') ||
          Object.prototype.hasOwnProperty.call(body, 'attendanceSchedule')
        ) {
          const rawAtt = body.attendance_schedule ?? body.attendanceSchedule;
          const attResult = employeeNested.validateAttendanceSchedulePayload(rawAtt);
          if (!attResult.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, attResult.message);
          }
          await employeeNested.upsertAttendanceProfile(client, id, admin.company_id, attResult.row);
        }

        if (Object.prototype.hasOwnProperty.call(body, 'documents')) {
          try {
            await employeeNested.replaceEmployeeDocuments(
              client,
              id,
              admin.company_id,
              employeeNested.parseDocumentsArray(body.documents)
            );
          } catch (linkErr) {
            await client.query('ROLLBACK');
            if (linkErr.message && linkErr.message.startsWith('DOCUMENT_TYPE_NOT_FOUND:')) {
              const badId = linkErr.message.split(':')[1];
              return sendError(res, 400, `Invalid document_type_id: ${badId} for this company.`);
            }
            console.error('Update employee documents error:', linkErr);
            return sendError(res, 500, 'Something went wrong while updating employee.');
          }
        }

        if (Object.prototype.hasOwnProperty.call(body, 'dependants')) {
          try {
            await employeeNested.saveEmployeeDependantIds(
              client,
              id,
              admin.company_id,
              employeeNested.parseDependantIdsArray(body.dependants)
            );
          } catch (linkErr) {
            await client.query('ROLLBACK');
            if (linkErr.message && linkErr.message.startsWith('DEPENDANT_NOT_FOUND:')) {
              const badId = linkErr.message.split(':')[1];
              return sendError(res, 400, `Invalid dependant id: ${badId} for this company.`);
            }
            console.error('Update employee dependants error:', linkErr);
            return sendError(res, 500, 'Something went wrong while updating employee.');
          }
        }

        const employeeBankId = employeeNested.parseEmployeeBankId(
          body.employee_bank ?? body.employeeBank ?? body.bank_details ?? body.employee_bank_details
        );
        if (
          Object.prototype.hasOwnProperty.call(body, 'employee_bank') ||
          Object.prototype.hasOwnProperty.call(body, 'employeeBank') ||
          Object.prototype.hasOwnProperty.call(body, 'bank_details') ||
          Object.prototype.hasOwnProperty.call(body, 'employee_bank_details')
        ) {
          const bankPayload = employeeNested.parseEmployeeBankPayload(
            body.employee_bank ?? body.employeeBank ?? body.bank_details ?? body.employee_bank_details
          );
          if (!bankPayload.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, bankPayload.message);
          }
          if (bankPayload.value) {
            await employeeNested.upsertEmployeeBankDetails(client, id, admin.company_id, bankPayload.value);
          } else {
            const bankCheck = await employeeNested.validateEmployeeBankBelongsToEmployee(
              client,
              id,
              admin.company_id,
              employeeBankId
            );
            if (!bankCheck.ok) {
              await client.query('ROLLBACK');
              return sendError(res, 400, bankCheck.message);
            }
          }
        }

        const refreshed = await client.query(
          `SELECT ${EMPLOYEE_SELECT_FIELDS}
          FROM employees
          WHERE id = $1 AND company_id = $2`,
          [id, admin.company_id]
        );
        employee = refreshed.rows[0];

        const officialInfo = await getOfficialInfoByEmployeeId(client, employee.id);
        const userRow = await getEmployeeUserRow(client, employee.id, admin.company_id);
        const nestedPayload = await employeeNested.buildNestedEmployeePayload(
          client,
          employee,
          officialInfo,
          admin.company_id
        );
        if (nestedPayload?.official) {
          nestedPayload.official.access_role_id = userRow?.access_role_id != null ? String(userRow.access_role_id) : null;
          nestedPayload.official.access_role_name = userRow?.access_role_name ?? null;
        }

        await client.query('COMMIT');

        if (shouldSendStatusEmail) {
          try {
            const userResult = await pool.query(
              `SELECT email, is_active
               FROM users
               WHERE employee_id = $1 AND company_id = $2`,
              [employee.id, admin.company_id]
            );
            const user = userResult.rows[0];
            if (user?.email) {
              const emailResult = await sendEmployeeStatusUpdatedEmail(user.email, {
                companyId: admin.company_id,
                employeeName:
                  employee.full_name ||
                  `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                status: user.is_active ? 'Active' : 'Inactive',
              });
              if (!emailResult?.sent) {
                console.error(
                  `Employee status update email not sent for ${user.email}: ${emailResult?.reason || 'unknown error'}`
                );
              }
            } else {
              console.error(`Employee status update email skipped: no email for employee ${employee.id}`);
            }
          } catch (mailError) {
            console.error('Employee status update email error:', mailError);
          }
        }

        if (shouldSendDepartmentEmail && departmentNameForEmail) {
          await notifyEmployeeDepartmentAssignment({
            employee,
            companyId: admin.company_id,
            departmentName: departmentNameForEmail,
          });
        }

        if (hadNonStatusProfileUpdates) {
          await notifyEmployeeProfileUpdated({
            employee,
            companyId: admin.company_id,
          });
        }

        return sendSuccess(res, 200, 'Employee updated successfully.', {
          status: deriveEmployeeStatus(userRow),
          ...nestedPayload,
        });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error.statusCode === 400) {
        return sendError(res, 400, error.message);
      }
      if (error.code === '23505') {
        return sendError(res, 409, getDuplicateValueMessage(error));
      }
      console.error('Update employee error:', error);
      return sendError(res, 500, 'Something went wrong while updating employee.');
    }
  }

async function deleteEmployeeById(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid employee id.');
  }

  try {
    const scope = await resolveEmployeeAccessScope(req.authUser);
    if (scope.error) {
      return sendError(res, 404, scope.error);
    }
    const admin = { company_id: scope.companyId };

    if (scope.mode === 'team' && !(await isDirectReportOf(scope.companyId, scope.managerEmployeeId, id))) {
      return sendError(res, 404, 'Employee not found.');
    }

    const result = await pool.query(
      `DELETE FROM employees
       WHERE id = $1 AND company_id = $2
       RETURNING id`,
      [id, admin.company_id]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'Employee not found.');
    }

    return sendSuccess(res, 200, 'Employee deleted successfully.', {
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error('Delete employee error:', error);
    return sendError(res, 500, 'Something went wrong while deleting employee.');
  }
}

function legacyShiftMinutesFromTime(time) {
  if (!time) return null;
  const [hours, minutes] = String(time).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function legacyShiftDurationMinutes(start, end) {
  const startMinutes = legacyShiftMinutesFromTime(start);
  const endMinutes = legacyShiftMinutesFromTime(end);
  if (startMinutes === null || endMinutes === null) return 0;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
}

function mapLegacyShiftRow(row) {
  const grossShiftMinutes = legacyShiftDurationMinutes(row.start_time, row.end_time);
  const breakDurationMinutes =
    row.break_start_time && row.break_end_time
      ? legacyShiftDurationMinutes(row.break_start_time, row.break_end_time)
      : 0;
  const scheduledWorkMinutes = row.exclude_break_from_working_hours
    ? Math.max(grossShiftMinutes - breakDurationMinutes, 0)
    : grossShiftMinutes;

  return {
    ...row,
    exclude_break_from_working_hours: Boolean(row.exclude_break_from_working_hours),
    working_hours_threshold_minutes: Number(row.working_hours_threshold_minutes ?? 0),
    gross_shift_minutes: grossShiftMinutes,
    gross_shift_hours: Number((grossShiftMinutes / 60).toFixed(2)),
    break_duration_minutes: breakDurationMinutes,
    break_duration_hours: Number((breakDurationMinutes / 60).toFixed(2)),
    scheduled_work_minutes: scheduledWorkMinutes,
    scheduled_work_hours: Number((scheduledWorkMinutes / 60).toFixed(2)),
  };
}

async function createShift(req, res) {
  const {
    name,
    start_time,
    end_time,
    break_start_time = null,
    break_end_time = null,
    exclude_break_from_working_hours = false,
    working_hours_threshold_minutes = 0,
    is_active,
  } = req.body || {};
  const shiftName = String(name || '').trim();
  const startTime = String(start_time || '').trim();
  const endTime = String(end_time || '').trim();
  if (!shiftName || !startTime || !endTime) {
    return sendError(res, 400, 'Please provide name, start_time, and end_time.');
  }

  try {
    const adminResult = await pool.query(
      `SELECT id, company_id, email, role, is_active FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );
    if (adminResult.rowCount === 0) return sendError(res, 401, 'Authenticated company admin not found.');
    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN || !admin.is_active || !admin.company_id) {
      return sendError(res, 403, 'Only an active company admin can create shifts.');
    }

    const result = await pool.query(
      `INSERT INTO shifts (
         company_id, name, start_time, end_time, break_start_time, break_end_time,
         exclude_break_from_working_hours, working_hours_threshold_minutes,
         is_active, created_at, updated_at
       )
       VALUES ($1, $2, $3::time, $4::time, $5::time, $6::time, $7, $8, $9, NOW(), NOW())
       RETURNING id, company_id, name, start_time, end_time, break_start_time, break_end_time,
                 exclude_break_from_working_hours, working_hours_threshold_minutes, is_active, created_at`,
      [
        admin.company_id,
        shiftName,
        startTime,
        endTime,
        break_start_time || null,
        break_end_time || null,
        exclude_break_from_working_hours === true,
        Number(working_hours_threshold_minutes) || 0,
        is_active !== false,
      ]
    );

    return sendSuccess(res, 201, 'Shift created successfully.', mapLegacyShiftRow(result.rows[0]));
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'A shift with this name already exists.');
    console.error('Create shift error:', error);
    return sendError(res, 500, 'Something went wrong while creating shift.');
  }
}

async function getShifts(req, res) {
  try {
    const adminResult = await pool.query(
      `SELECT id, company_id, email, role, is_active FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );
    if (adminResult.rowCount === 0) return sendError(res, 401, 'Authenticated company admin not found.');
    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN || !admin.is_active || !admin.company_id) {
      return sendError(res, 403, 'Only an active company admin can view shifts.');
    }

    const result = await pool.query(
      `SELECT id, company_id, name, start_time, end_time, break_start_time, break_end_time,
              exclude_break_from_working_hours, working_hours_threshold_minutes, is_active, created_at
       FROM shifts
       WHERE company_id = $1
       ORDER BY id DESC`,
      [admin.company_id]
    );
    return sendSuccess(res, 200, 'Shifts fetched successfully.', {
      shifts: result.rows.map(mapLegacyShiftRow),
    });
  } catch (error) {
    console.error('Get shifts error:', error);
    return sendError(res, 500, 'Something went wrong while fetching shifts.');
  }
}

async function updateEmployeeAccountAccess(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid employee id.');
  }

  const body = req.body || {};
  const action = String(body.action || 'reset_password').trim().toLowerCase();
  const passwordValue = resolvePasswordFromBody(body);

  if (!['reset_password', 'reset'].includes(action)) {
    return sendError(res, 400, 'Only reset_password action is supported.');
  }

  if (!passwordValue) {
    return sendError(res, 400, 'Please provide a password.');
  }

  const passwordValidationError = validateEmployeePassword(passwordValue);
  if (passwordValidationError) {
    return sendError(res, 400, passwordValidationError);
  }

  try {
    const scope = await resolveEmployeeAccessScope(req.authUser);
    if (scope.error) {
      return sendError(res, 404, scope.error);
    }
    const admin = { company_id: scope.companyId };

    if (scope.mode === 'team' && !(await isDirectReportOf(scope.companyId, scope.managerEmployeeId, id))) {
      return sendError(res, 404, 'Employee not found.');
    }

    const employeeResult = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [id, admin.company_id]
    );
    if (employeeResult.rowCount === 0) {
      return sendError(res, 404, 'Employee not found.');
    }

    const userResult = await pool.query(
      `SELECT id, email FROM users WHERE employee_id = $1 AND company_id = $2`,
      [id, admin.company_id]
    );
    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'No login account found for this employee.');
    }

    const user = userResult.rows[0];
    const password_hash = await bcrypt.hash(passwordValue, 10);

    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [password_hash, user.id]
    );

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendEmployeeTemporaryCredentialsEmail(user.email, passwordValue, {
        companyId: admin.company_id,
      });
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for employee credentials: ${emailResult.reason}`);
    }

    return sendSuccess(res, 200, 'Employee password updated successfully.', {
      credentials_email_sent: Boolean(emailResult.sent),
      credentials_email_error: emailResult.sent ? null : emailResult.reason,
    });
  } catch (error) {
    console.error('Update employee account access error:', error);
    return sendError(res, 500, 'Something went wrong while updating employee password.');
  }
}

module.exports = {
  addEmployee,
  bulkAddEmployees,
  getEmployees,
  getEmployeeById,
  updateEmployeeById,
  updateEmployeeAccountAccess,
  deleteEmployeeById,
  createShift,
  getShifts,
};
