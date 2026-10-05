const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp, parseOptionalDateInput } = require('../utils/dateTime');
const { grantAnniversaryBalancesToEmployees } = require('./leaveCycle.service');

const PAID_STATUSES = new Set(['paid', 'unpaid']);
const POLICY_STATUSES = new Set(['active', 'inactive']);
const CODE_PATTERN = /^[A-Z0-9]{1,20}$/;
const FILTER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SORT_FIELDS = new Map([['created_at', 'created_at']]);

function normalizeFilterDate(raw, fieldName) {
  return parseOptionalDateInput(raw, fieldName);
}

function parseSort(query = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'created_at').trim();
  const sortColumn = SORT_FIELDS.get(sortByRaw);
  if (!sortColumn) {
    return { error: `sort_by must be one of: ${Array.from(SORT_FIELDS.keys()).join(', ')}.` };
  }
  const orderRaw = String(query.sort_order || query.sortOrder || 'desc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(orderRaw)) {
    return { error: 'sort_order must be asc or desc.' };
  }
  return {
    orderBySql: `${sortColumn} ${orderRaw.toUpperCase()}, id DESC`,
    sort_by: sortByRaw,
    sort_order: orderRaw,
  };
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeCode(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase();
  if (!code) return { error: 'code is required.' };
  if (!CODE_PATTERN.test(code)) {
    return { error: 'code must be 1–20 uppercase letters or digits (e.g. AL).' };
  }
  return { code };
}

function normalizePaidStatus(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!PAID_STATUSES.has(value)) {
    return { error: 'paid_status must be one of: paid, unpaid.' };
  }
  return { value };
}

function normalizePolicyStatus(raw, defaultValue = 'active') {
  if (raw === undefined || raw === null || raw === '') {
    return { value: defaultValue };
  }
  const value = String(raw).trim().toLowerCase();
  if (!POLICY_STATUSES.has(value)) {
    return { error: 'status must be one of: active, inactive.' };
  }
  return { value };
}

function normalizeDaysPerYear(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { error: 'days_per_year is required.' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { error: 'days_per_year must be a number greater than or equal to 0.' };
  }
  return { value: Math.round(n * 100) / 100 };
}

function mapLeavePolicyRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    code: row.code,
    paid_status: row.paid_status,
    days_per_year: Number(row.days_per_year),
    status: row.status,
    eligible_department_id: row.eligible_department_id != null ? Number(row.eligible_department_id) : null,
    eligible_designation_id: row.eligible_designation_id != null ? Number(row.eligible_designation_id) : null,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
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

const MAX_BULK_LEAVE_POLICIES = 50;

async function fetchLeavePolicyById(policyId, companyId) {
  const result = await pool.query(
    `SELECT * FROM leave_policies WHERE id = $1 AND company_id = $2`,
    [policyId, companyId]
  );
  return result.rows[0] || null;
}

function parseLeavePolicyFields(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name is required.' };
  if (name.length > 120) return { error: 'name must be at most 120 characters.' };

  const codeResult = normalizeCode(body.code);
  if (codeResult.error) return { error: codeResult.error };

  const paidResult = normalizePaidStatus(body.paid_status);
  if (paidResult.error) return { error: paidResult.error };

  const daysResult = normalizeDaysPerYear(body.days_per_year);
  if (daysResult.error) return { error: daysResult.error };

  const statusResult = normalizePolicyStatus(body.status);
  if (statusResult.error) return { error: statusResult.error };

  return {
    name,
    code: codeResult.code,
    paid_status: paidResult.value,
    days_per_year: daysResult.value,
    status: statusResult.value,
  };
}

/**
 * Eligibility rule: if leave_policy_eligible_employees has rows for this policy, those
 * employee ids are exactly who's eligible. Otherwise eligible = employees matching
 * eligible_department_id / eligible_designation_id (either/both NULL = unrestricted on
 * that axis). If nothing is set, eligible = every employee in the company.
 */
async function computeEligibleEmployeeIds(db, companyId, policyId, eligibleDepartmentId, eligibleDesignationId) {
  const explicit = await db.query(
    `SELECT employee_id FROM leave_policy_eligible_employees WHERE leave_policy_id = $1`,
    [policyId]
  );
  if (explicit.rowCount > 0) {
    return explicit.rows.map((row) => Number(row.employee_id));
  }

  const result = await db.query(
    `SELECT e.id
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND ($2::bigint IS NULL OR ejd.department_id = $2::bigint)
       AND ($3::bigint IS NULL OR ejd.designation_id = $3::bigint)`,
    [companyId, eligibleDepartmentId, eligibleDesignationId]
  );
  return result.rows.map((row) => Number(row.id));
}

async function grantBalancesToEmployees(client, companyId, policyId, employeeIds, daysPerYear, _year, nowUtc) {
  // Anniversary cycles per employee. Legacy calendar-year rows are left untouched
  // when the same year already exists (see leaveCycle.service grant guards).
  await grantAnniversaryBalancesToEmployees(
    client,
    companyId,
    policyId,
    employeeIds,
    daysPerYear,
    nowUtc
  );
}

async function freezeBalancesForEmployees(client, companyId, policyId, employeeIds, nowUtc) {
  if (!employeeIds.length) return;
  await client.query(
    `UPDATE leave_balances
     SET total_days = used_days, available_days = 0, updated_at = $1::timestamp
     WHERE leave_policy_id = $2 AND company_id = $3 AND employee_id = ANY($4::bigint[])
       AND COALESCE(cycle_status, 'active') = 'active'`,
    [nowUtc, policyId, companyId, employeeIds]
  );
}

async function insertEligibleEmployees(client, companyId, policyId, employeeIds) {
  if (!employeeIds.length) return;
  const values = [];
  const placeholders = employeeIds
    .map((employeeId, i) => {
      values.push(companyId, policyId, employeeId);
      const base = i * 3;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    })
    .join(', ');
  await client.query(
    `INSERT INTO leave_policy_eligible_employees (company_id, leave_policy_id, employee_id)
     VALUES ${placeholders}
     ON CONFLICT (leave_policy_id, employee_id) DO NOTHING`,
    values
  );
}

async function validateDepartmentBelongsToCompany(departmentId, companyId) {
  const check = await pool.query(`SELECT 1 FROM departments WHERE id = $1 AND company_id = $2`, [
    departmentId,
    companyId,
  ]);
  return check.rowCount > 0;
}

async function validateDesignationBelongsToCompany(designationId, companyId) {
  const check = await pool.query(`SELECT 1 FROM designations WHERE id = $1 AND company_id = $2`, [
    designationId,
    companyId,
  ]);
  return check.rowCount > 0;
}

async function validateEmployeeIdsBelongToCompany(employeeIds, companyId) {
  if (!employeeIds.length) return true;
  const check = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM employees WHERE company_id = $1 AND id = ANY($2::bigint[])`,
    [companyId, employeeIds]
  );
  return Number(check.rows[0]?.cnt) === employeeIds.length;
}

/** Validates and normalizes the optional eligible_department_id/eligible_designation_id/eligible_employee_ids fields. */
async function parseEligibilityFields(companyId, body = {}) {
  let departmentId = null;
  if (body.eligible_department_id !== undefined && body.eligible_department_id !== null && body.eligible_department_id !== '') {
    departmentId = parsePositiveInt(body.eligible_department_id);
    if (!departmentId) return { error: 'eligible_department_id must be a positive integer.' };
    const ok = await validateDepartmentBelongsToCompany(departmentId, companyId);
    if (!ok) return { error: 'eligible_department_id does not belong to your company.' };
  }

  let designationId = null;
  if (body.eligible_designation_id !== undefined && body.eligible_designation_id !== null && body.eligible_designation_id !== '') {
    designationId = parsePositiveInt(body.eligible_designation_id);
    if (!designationId) return { error: 'eligible_designation_id must be a positive integer.' };
    const ok = await validateDesignationBelongsToCompany(designationId, companyId);
    if (!ok) return { error: 'eligible_designation_id does not belong to your company.' };
  }

  let employeeIds = [];
  if (body.eligible_employee_ids !== undefined && body.eligible_employee_ids !== null) {
    if (!Array.isArray(body.eligible_employee_ids)) return { error: 'eligible_employee_ids must be an array.' };
    const parsedIds = [];
    for (const raw of body.eligible_employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: 'eligible_employee_ids must contain positive integers.' };
      parsedIds.push(id);
    }
    employeeIds = [...new Set(parsedIds)];
    const ok = await validateEmployeeIdsBelongToCompany(employeeIds, companyId);
    if (!ok) return { error: 'One or more eligible_employee_ids do not belong to your company.' };
  }

  return { department_id: departmentId, designation_id: designationId, employee_ids: employeeIds };
}

async function createLeavePolicy(companyId, body) {
  const parsed = parseLeavePolicyFields(body);
  if (parsed.error) return { error: [400, parsed.error] };

  const eligibility = await parseEligibilityFields(companyId, body);
  if (eligibility.error) return { error: [400, eligibility.error] };

  const nowUtc = utcNowForPgTimestamp();
  const year = new Date().getUTCFullYear();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO leave_policies (
         company_id, name, code, paid_status, days_per_year, status,
         eligible_department_id, eligible_designation_id, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $9::timestamp)
       RETURNING *`,
      [
        companyId,
        parsed.name,
        parsed.code,
        parsed.paid_status,
        parsed.days_per_year,
        parsed.status,
        eligibility.department_id,
        eligibility.designation_id,
        nowUtc,
      ]
    );
    const policyRow = insert.rows[0];

    if (eligibility.employee_ids.length > 0) {
      await insertEligibleEmployees(client, companyId, policyRow.id, eligibility.employee_ids);
    }

    if (parsed.status === 'active') {
      const eligibleIds = await computeEligibleEmployeeIds(
        client,
        companyId,
        policyRow.id,
        eligibility.department_id,
        eligibility.designation_id
      );
      await grantBalancesToEmployees(client, companyId, policyRow.id, eligibleIds, parsed.days_per_year, year, nowUtc);
    }

    await client.query('COMMIT');
    return { leave_policy: mapLeavePolicyRow(policyRow) };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error?.code === '23505') {
      return { error: [409, 'A leave policy with this name or code already exists for this company.'] };
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Atomic bulk import: if any row is invalid, nothing is saved. */
async function bulkImportLeavePolicies(companyId, body = {}) {
  const rows = Array.isArray(body.rows)
    ? body.rows
    : Array.isArray(body.entries)
      ? body.entries
      : null;

  if (!rows || rows.length === 0) {
    return { error: [400, 'rows must be a non-empty array.'] };
  }
  if (rows.length > MAX_BULK_LEAVE_POLICIES) {
    return {
      error: [400, `Maximum ${MAX_BULK_LEAVE_POLICIES} leave policies per import request.`],
    };
  }

  const validRows = [];
  const rowErrors = [];
  const seenNames = new Map();
  const seenCodes = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const parsed = parseLeavePolicyFields(rows[i] || {});
    if (parsed.error) {
      rowErrors.push({ row_index: i, reason: parsed.error });
      continue;
    }

    const nameKey = parsed.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      rowErrors.push({
        row_index: i,
        reason: `Duplicate name "${parsed.name}" in import payload (also at row ${seenNames.get(nameKey)}).`,
      });
      continue;
    }
    if (seenCodes.has(parsed.code)) {
      rowErrors.push({
        row_index: i,
        reason: `Duplicate code "${parsed.code}" in import payload (also at row ${seenCodes.get(parsed.code)}).`,
      });
      continue;
    }

    seenNames.set(nameKey, i);
    seenCodes.set(parsed.code, i);
    validRows.push({ row_index: i, ...parsed });
  }

  if (rowErrors.length > 0) {
    return {
      error: [
        400,
        `Import rejected: ${rowErrors.length} invalid row(s). No rows were saved.`,
        {
          errors: rowErrors,
          valid_count: validRows.length,
          invalid_count: rowErrors.length,
        },
      ],
    };
  }

  const nowUtc = utcNowForPgTimestamp();
  const year = new Date().getUTCFullYear();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const created = [];

    for (const row of validRows) {
      try {
        const insert = await client.query(
          `INSERT INTO leave_policies (
             company_id, name, code, paid_status, days_per_year, status, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)
           RETURNING *`,
          [
            companyId,
            row.name,
            row.code,
            row.paid_status,
            row.days_per_year,
            row.status,
            nowUtc,
          ]
        );
        const policyRow = insert.rows[0];

        if (row.status === 'active') {
          // Bulk-imported policies have no eligibility scoping, so this resolves to all company employees.
          const eligibleIds = await computeEligibleEmployeeIds(client, companyId, policyRow.id, null, null);
          await grantBalancesToEmployees(client, companyId, policyRow.id, eligibleIds, row.days_per_year, year, nowUtc);
        }

        created.push(mapLeavePolicyRow(policyRow));
      } catch (error) {
        if (error?.code === '23505') {
          await client.query('ROLLBACK');
          return {
            error: [
              409,
              'Import rejected: a leave policy with this name or code already exists for this company.',
              {
                errors: [
                  {
                    row_index: row.row_index,
                    reason:
                      'A leave policy with this name or code already exists for this company.',
                  },
                ],
              },
            ],
          };
        }
        throw error;
      }
    }

    await client.query('COMMIT');
    return {
      count: created.length,
      leave_policies: created,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getEmployeeDepartmentDesignation(employeeId) {
  const result = await pool.query(
    `SELECT department_id, designation_id FROM employee_job_details WHERE employee_id = $1`,
    [employeeId]
  );
  const row = result.rows[0];
  return {
    departmentId: row?.department_id != null ? Number(row.department_id) : null,
    designationId: row?.designation_id != null ? Number(row.designation_id) : null,
  };
}

async function isEmployeeEligibleForPolicy(employeeId, policyRow) {
  const explicit = await pool.query(
    `SELECT 1 FROM leave_policy_eligible_employees WHERE leave_policy_id = $1 AND employee_id = $2`,
    [policyRow.id, employeeId]
  );
  if (explicit.rowCount > 0) return true;

  const anyExplicit = await pool.query(
    `SELECT 1 FROM leave_policy_eligible_employees WHERE leave_policy_id = $1 LIMIT 1`,
    [policyRow.id]
  );
  if (anyExplicit.rowCount > 0) return false;

  const { departmentId, designationId } = await getEmployeeDepartmentDesignation(employeeId);
  const deptOk = policyRow.eligible_department_id == null || Number(policyRow.eligible_department_id) === departmentId;
  const desigOk =
    policyRow.eligible_designation_id == null || Number(policyRow.eligible_designation_id) === designationId;
  return deptOk && desigOk;
}

async function getLeavePolicies(companyId, query, employeeContext = null) {
  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;

  const statusFilter = query?.status !== undefined ? String(query.status).trim().toLowerCase() : '';
  if (statusFilter && !POLICY_STATUSES.has(statusFilter)) {
    return { error: [400, 'status filter must be one of: active, inactive.'] };
  }

  const paidStatusFilter =
    query?.paid_status !== undefined ? String(query.paid_status).trim().toLowerCase() : '';
  if (paidStatusFilter && !PAID_STATUSES.has(paidStatusFilter)) {
    return { error: [400, 'paid_status filter must be one of: paid, unpaid.'] };
  }

  const createdFromResult = normalizeFilterDate(query?.created_from, 'created_from');
  if (createdFromResult.error) return { error: [400, createdFromResult.error] };

  const createdToResult = normalizeFilterDate(query?.created_to, 'created_to');
  if (createdToResult.error) return { error: [400, createdToResult.error] };

  if (createdFromResult.value && createdToResult.value && createdToResult.value < createdFromResult.value) {
    return { error: [400, 'created_to cannot be before created_from.'] };
  }

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query);
  if (sort.error) return { error: [400, sort.error] };

  let whereSql = `company_id = $1
       AND ($2::text = '' OR status = $2)
       AND (
         $3::text = ''
         OR name ILIKE $3
         OR code ILIKE $3
       )
       AND ($4::text = '' OR paid_status = $4)
       AND ($5::date IS NULL OR created_at >= $5::date)
       AND ($6::date IS NULL OR created_at < ($6::date + INTERVAL '1 day'))`;

  const values = [
    companyId,
    statusFilter,
    hasSearch ? searchLike : '',
    paidStatusFilter,
    createdFromResult.value,
    createdToResult.value,
  ];

  if (employeeContext) {
    const employeeIdPos = values.length + 1;
    const departmentIdPos = values.length + 2;
    const designationIdPos = values.length + 3;
    values.push(employeeContext.employeeId, employeeContext.departmentId, employeeContext.designationId);
    whereSql += `
       AND (
         EXISTS (
           SELECT 1 FROM leave_policy_eligible_employees el
           WHERE el.leave_policy_id = leave_policies.id AND el.employee_id = $${employeeIdPos}
         )
         OR (
           NOT EXISTS (
             SELECT 1 FROM leave_policy_eligible_employees el2 WHERE el2.leave_policy_id = leave_policies.id
           )
           AND (eligible_department_id IS NULL OR eligible_department_id = $${departmentIdPos}::bigint)
           AND (eligible_designation_id IS NULL OR eligible_designation_id = $${designationIdPos}::bigint)
         )
       )`;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM leave_policies WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT * FROM leave_policies WHERE ${whereSql} ORDER BY ${sort.orderBySql}`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    leave_policies: result.rows.map(mapLeavePolicyRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      status: statusFilter || null,
      paid_status: paidStatusFilter || null,
      search: search || null,
      created_from: createdFromResult.value,
      created_to: createdToResult.value,
    },
  };
}

async function getLeavePolicyById(policyId, companyId) {
  const row = await fetchLeavePolicyById(policyId, companyId);
  if (!row) return { error: [404, 'Leave policy not found.'] };

  const [employeeRows, departmentRow, designationRow] = await Promise.all([
    pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.work_email
       FROM leave_policy_eligible_employees el
       JOIN employees e ON e.id = el.employee_id
       WHERE el.leave_policy_id = $1
       ORDER BY e.first_name, e.last_name`,
      [policyId]
    ),
    row.eligible_department_id
      ? pool.query(`SELECT name FROM departments WHERE id = $1`, [row.eligible_department_id])
      : null,
    row.eligible_designation_id
      ? pool.query(`SELECT name FROM designations WHERE id = $1`, [row.eligible_designation_id])
      : null,
  ]);

  const eligibleEmployees = employeeRows.rows.map((r) => ({
    id: Number(r.id),
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || `Employee #${r.id}`,
    email: r.work_email || null,
  }));

  return {
    leave_policy: {
      ...mapLeavePolicyRow(row),
      eligible_employee_ids: eligibleEmployees.map((e) => e.id),
      eligible_employees: eligibleEmployees,
      eligible_department_name: departmentRow?.rows?.[0]?.name || null,
      eligible_designation_name: designationRow?.rows?.[0]?.name || null,
    },
  };
}

/** Active leave policies the given employee is actually eligible for (department/designation/explicit-employee scoping applied). */
async function getMyLeavePolicies(companyId, employeeId, query) {
  const { departmentId, designationId } = await getEmployeeDepartmentDesignation(employeeId);
  return getLeavePolicies(companyId, { ...query, status: 'active' }, { employeeId, departmentId, designationId });
}

/** Single active leave policy, only if the given employee is eligible for it. */
async function getMyLeavePolicyById(policyId, companyId, employeeId) {
  const result = await getLeavePolicyById(policyId, companyId);
  if (result.error) return result;
  if (result.leave_policy.status !== 'active') {
    return { error: [404, 'Leave policy not found.'] };
  }
  const eligible = await isEmployeeEligibleForPolicy(employeeId, result.leave_policy);
  if (!eligible) {
    return { error: [404, 'Leave policy not found.'] };
  }
  return result;
}

async function updateLeavePolicy(policyId, companyId, body) {
  const allowedKeys = new Set([
    'name',
    'code',
    'paid_status',
    'days_per_year',
    'status',
    'eligible_department_id',
    'eligible_designation_id',
    'eligible_employee_ids',
  ]);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasCode = Object.prototype.hasOwnProperty.call(body, 'code');
  const hasPaidStatus = Object.prototype.hasOwnProperty.call(body, 'paid_status');
  const hasDays = Object.prototype.hasOwnProperty.call(body, 'days_per_year');
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  const hasEligibleDepartment = Object.prototype.hasOwnProperty.call(body, 'eligible_department_id');
  const hasEligibleDesignation = Object.prototype.hasOwnProperty.call(body, 'eligible_designation_id');
  const hasEligibleEmployeeIds = Object.prototype.hasOwnProperty.call(body, 'eligible_employee_ids');

  if (
    !hasName &&
    !hasCode &&
    !hasPaidStatus &&
    !hasDays &&
    !hasStatus &&
    !hasEligibleDepartment &&
    !hasEligibleDesignation &&
    !hasEligibleEmployeeIds
  ) {
    return { error: [400, 'Provide at least one field to update.'] };
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

  if (hasCode) {
    const codeResult = normalizeCode(body.code);
    if (codeResult.error) return { error: [400, codeResult.error] };
    updates.push(`code = $${idx++}`);
    values.push(codeResult.code);
  }

  if (hasPaidStatus) {
    const paidResult = normalizePaidStatus(body.paid_status);
    if (paidResult.error) return { error: [400, paidResult.error] };
    updates.push(`paid_status = $${idx++}`);
    values.push(paidResult.value);
  }

  if (hasDays) {
    const daysResult = normalizeDaysPerYear(body.days_per_year);
    if (daysResult.error) return { error: [400, daysResult.error] };
    updates.push(`days_per_year = $${idx++}`);
    values.push(daysResult.value);
  }

  let newStatusValue = null;
  if (hasStatus) {
    if (body.status === undefined || body.status === null || String(body.status).trim() === '') {
      return { error: [400, 'status cannot be empty.'] };
    }
    const statusResult = normalizePolicyStatus(body.status);
    if (statusResult.error) return { error: [400, statusResult.error] };
    newStatusValue = statusResult.value;
    updates.push(`status = $${idx++}`);
    values.push(statusResult.value);
  }

  if (hasEligibleDepartment) {
    let newDepartmentId = null;
    if (body.eligible_department_id !== null && body.eligible_department_id !== '') {
      newDepartmentId = parsePositiveInt(body.eligible_department_id);
      if (!newDepartmentId) return { error: [400, 'eligible_department_id must be a positive integer.'] };
      const ok = await validateDepartmentBelongsToCompany(newDepartmentId, companyId);
      if (!ok) return { error: [400, 'eligible_department_id does not belong to your company.'] };
    }
    updates.push(`eligible_department_id = $${idx++}`);
    values.push(newDepartmentId);
  }

  if (hasEligibleDesignation) {
    let newDesignationId = null;
    if (body.eligible_designation_id !== null && body.eligible_designation_id !== '') {
      newDesignationId = parsePositiveInt(body.eligible_designation_id);
      if (!newDesignationId) return { error: [400, 'eligible_designation_id must be a positive integer.'] };
      const ok = await validateDesignationBelongsToCompany(newDesignationId, companyId);
      if (!ok) return { error: [400, 'eligible_designation_id does not belong to your company.'] };
    }
    updates.push(`eligible_designation_id = $${idx++}`);
    values.push(newDesignationId);
  }

  let newEmployeeIds = null;
  if (hasEligibleEmployeeIds) {
    if (!Array.isArray(body.eligible_employee_ids)) {
      return { error: [400, 'eligible_employee_ids must be an array.'] };
    }
    const parsedIds = [];
    for (const raw of body.eligible_employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: [400, 'eligible_employee_ids must contain positive integers.'] };
      parsedIds.push(id);
    }
    newEmployeeIds = [...new Set(parsedIds)];
    const ok = await validateEmployeeIdsBelongToCompany(newEmployeeIds, companyId);
    if (!ok) return { error: [400, 'One or more eligible_employee_ids do not belong to your company.'] };
  }

  const nowUtc = utcNowForPgTimestamp();
  updates.push(`updated_at = $${idx++}::timestamp`);
  values.push(nowUtc);
  values.push(policyId, companyId);
  const idPos = idx++;
  const companyPos = idx++;

  const year = new Date().getUTCFullYear();
  const eligibilityChanged = hasEligibleDepartment || hasEligibleDesignation || hasEligibleEmployeeIds;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingPolicy = await client.query(
      `SELECT status, eligible_department_id, eligible_designation_id
       FROM leave_policies
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [policyId, companyId]
    );
    if (existingPolicy.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Leave policy not found.'] };
    }
    const existingRow = existingPolicy.rows[0];

    let oldEligibleIds = [];
    if (eligibilityChanged && existingRow.status === 'active') {
      oldEligibleIds = await computeEligibleEmployeeIds(
        client,
        companyId,
        policyId,
        existingRow.eligible_department_id,
        existingRow.eligible_designation_id
      );
    }

    const updated = await client.query(
      `UPDATE leave_policies
       SET ${updates.join(', ')}
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Leave policy not found.'] };
    }

    const policyRow = updated.rows[0];

    if (hasEligibleEmployeeIds) {
      await client.query(`DELETE FROM leave_policy_eligible_employees WHERE leave_policy_id = $1`, [policyId]);
      if (newEmployeeIds.length > 0) {
        await insertEligibleEmployees(client, companyId, policyId, newEmployeeIds);
      }
    }

    const effectiveStatus = newStatusValue || existingRow.status;

    if (newStatusValue === 'inactive') {
      // Revoke remaining balance under this policy for every employee/year; used_days stays as the historical record.
      await client.query(
        `UPDATE leave_balances
         SET total_days = used_days,
             available_days = 0,
             cycle_status = CASE WHEN period_start IS NOT NULL THEN 'expired' ELSE cycle_status END,
             updated_at = $1::timestamp
         WHERE leave_policy_id = $2 AND company_id = $3
           AND COALESCE(cycle_status, 'active') = 'active'`,
        [nowUtc, policyId, companyId]
      );
    } else if (effectiveStatus === 'active') {
      const daysPerYear = Number(policyRow.days_per_year);
      const newEligibleIds = await computeEligibleEmployeeIds(
        client,
        companyId,
        policyId,
        policyRow.eligible_department_id,
        policyRow.eligible_designation_id
      );

      if (newStatusValue === 'active') {
        // (Re)activation: restore + grant for the eligible set, freeze anyone else with a stale row.
        await client.query(
          `UPDATE leave_balances
           SET total_days = GREATEST($1::numeric, used_days),
               available_days = GREATEST($1::numeric, used_days) - used_days,
               cycle_status = CASE WHEN period_start IS NOT NULL THEN 'active' ELSE cycle_status END,
               updated_at = $2::timestamp
           WHERE leave_policy_id = $3 AND company_id = $4 AND employee_id = ANY($5::bigint[])
             AND (
               period_start IS NULL
               OR (
                 COALESCE(cycle_status, 'active') = 'active'
                 OR (
                   period_start IS NOT NULL
                   AND (CURRENT_DATE AT TIME ZONE 'UTC')::date BETWEEN period_start AND period_end
                 )
               )
             )`,
          [daysPerYear, nowUtc, policyId, companyId, newEligibleIds]
        );
        await grantBalancesToEmployees(client, companyId, policyId, newEligibleIds, daysPerYear, year, nowUtc);
        await client.query(
          `UPDATE leave_balances
           SET total_days = used_days, available_days = 0, updated_at = $1::timestamp
           WHERE leave_policy_id = $2 AND company_id = $3 AND NOT (employee_id = ANY($4::bigint[]))
             AND COALESCE(cycle_status, 'active') = 'active'`,
          [nowUtc, policyId, companyId, newEligibleIds]
        );
      } else if (eligibilityChanged) {
        // Already active, only eligibility narrowed/widened: grant newly eligible, freeze newly ineligible.
        const addedIds = newEligibleIds.filter((id) => !oldEligibleIds.includes(id));
        const removedIds = oldEligibleIds.filter((id) => !newEligibleIds.includes(id));
        await grantBalancesToEmployees(client, companyId, policyId, addedIds, daysPerYear, year, nowUtc);
        await freezeBalancesForEmployees(client, companyId, policyId, removedIds, nowUtc);
      }
    }

    await client.query('COMMIT');
    return { leave_policy: mapLeavePolicyRow(policyRow) };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error?.code === '23505') {
      return { error: [409, 'A leave policy with this name or code already exists for this company.'] };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function deleteLeavePolicy(policyId, companyId) {
  const existing = await fetchLeavePolicyById(policyId, companyId);
  if (!existing) return { error: [404, 'Leave policy not found.'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestCheck = await client.query(
      `SELECT 1 FROM leave_requests WHERE leave_policy_id = $1 AND company_id = $2 LIMIT 1`,
      [policyId, companyId]
    );
    if (requestCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return {
        error: [409, 'This leave policy cannot be deleted because leave requests have been submitted against it.'],
      };
    }

    await client.query(
      `DELETE FROM leave_balances WHERE leave_policy_id = $1 AND company_id = $2`,
      [policyId, companyId]
    );

    await client.query(`DELETE FROM leave_policies WHERE id = $1 AND company_id = $2`, [
      policyId,
      companyId,
    ]);

    await client.query('COMMIT');
    return { leave_policy: mapLeavePolicyRow(existing) };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23503') {
      return {
        error: [409, 'This leave policy cannot be deleted because it is referenced by other records.'],
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  parsePositiveInt,
  getAuthenticatedCompanyAdmin,
  createLeavePolicy,
  bulkImportLeavePolicies,
  getLeavePolicies,
  getLeavePolicyById,
  getMyLeavePolicies,
  getMyLeavePolicyById,
  updateLeavePolicy,
  deleteLeavePolicy,
};
