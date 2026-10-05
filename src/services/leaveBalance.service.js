const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { getAuthenticatedCompanyAdmin, parsePositiveInt } = require('./leavePolicy.service');
const leaveEmailNotification = require('./leaveEmailNotification.service');
const {
  grantActivePolicyBalancesForEmployee,
  toDateOnlyString,
} = require('./leaveCycle.service');

const SORT_FIELDS = new Map([
  ['created_at', { row: 'lb.created_at', grouped: 'MAX(lb.created_at)' }],
  ['year', { row: 'lb.year', grouped: 'MAX(lb.year)' }],
  ['employee_name', { row: 'e.first_name', grouped: 'MIN(e.first_name)' }],
]);

const BALANCE_SELECT = `lb.id,
  lb.company_id,
  lb.employee_id,
  lb.leave_policy_id,
  lb.year,
  lb.total_days,
  lb.used_days,
  lb.available_days,
  lb.period_start,
  lb.period_end,
  lb.renewal_date,
  lb.cycle_status,
  lb.created_at,
  lb.updated_at,
  e.employee_code,
  e.first_name AS employee_first_name,
  e.last_name AS employee_last_name,
  e.work_email AS employee_email,
  lp.name AS leave_policy_name,
  lp.code AS leave_policy_code,
  lp.paid_status AS leave_policy_paid_status`;

const BALANCE_FROM = `FROM leave_balances lb
  INNER JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id
  INNER JOIN leave_policies lp ON lp.id = lb.leave_policy_id AND lp.company_id = lb.company_id`;

function parseSort(query = {}, { grouped = false } = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'created_at').trim();
  const fieldConfig = SORT_FIELDS.get(sortByRaw);
  if (!fieldConfig) {
    return { error: `sort_by must be one of: ${Array.from(SORT_FIELDS.keys()).join(', ')}.` };
  }
  const orderRaw = String(query.sort_order || query.sortOrder || 'desc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(orderRaw)) {
    return { error: 'sort_order must be asc or desc.' };
  }
  const column = grouped ? fieldConfig.grouped : fieldConfig.row;
  const tieBreaker = grouped ? 'lb.employee_id' : 'lb.id';
  return {
    orderBySql: `${column} ${orderRaw.toUpperCase()}, ${tieBreaker} DESC`,
    sort_by: sortByRaw,
    sort_order: orderRaw,
  };
}

function normalizeYear(raw, defaultYear = null) {
  if (raw === undefined || raw === null || raw === '') {
    if (defaultYear !== null) return { value: defaultYear };
    return { value: null };
  }
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: 'year must be an integer between 2000 and 2100.' };
  }
  return { value: year };
}

function normalizeDays(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '') {
    return { error: `${fieldName} is required.` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `${fieldName} must be a number greater than or equal to 0.` };
  }
  return { value: Math.round(n * 100) / 100 };
}

function mapLeavePolicySummary(row) {
  return {
    id: Number(row.leave_policy_id),
    name: row.leave_policy_name,
    code: row.leave_policy_code,
    paid_status: row.leave_policy_paid_status,
  };
}

function mapEmployeeSummary(row) {
  return {
    id: Number(row.employee_id),
    employee_code: row.employee_code ?? null,
    first_name: row.employee_first_name,
    last_name: row.employee_last_name,
    email: row.employee_email ?? null,
  };
}

function mapLeaveBalanceRow(row, { includeEmployee = false } = {}) {
  const item = {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    leave_policy_id: Number(row.leave_policy_id),
    leave_policy: mapLeavePolicySummary(row),
    year: Number(row.year),
    total_days: Number(row.total_days),
    used_days: Number(row.used_days),
    available_days: Number(row.available_days),
    period_start: toDateOnlyString(row.period_start),
    period_end: toDateOnlyString(row.period_end),
    renewal_date: toDateOnlyString(row.renewal_date),
    cycle_status: row.cycle_status || (row.period_start ? 'active' : null),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
  if (includeEmployee) {
    item.employee = mapEmployeeSummary(row);
  }
  return item;
}

function mapLeavePolicyBalance(row) {
  return {
    id: Number(row.id),
    leave_policy_id: Number(row.leave_policy_id),
    leave_policy: mapLeavePolicySummary(row),
    year: Number(row.year),
    total_days: Number(row.total_days),
    used_days: Number(row.used_days),
    available_days: Number(row.available_days),
    period_start: toDateOnlyString(row.period_start),
    period_end: toDateOnlyString(row.period_end),
    renewal_date: toDateOnlyString(row.renewal_date),
    cycle_status: row.cycle_status || (row.period_start ? 'active' : null),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function groupBalanceRowsByEmployee(rows) {
  const order = [];
  const byEmployeeId = new Map();

  for (const row of rows) {
    const employeeId = Number(row.employee_id);
    if (!byEmployeeId.has(employeeId)) {
      byEmployeeId.set(employeeId, {
        employee_id: employeeId,
        employee: mapEmployeeSummary(row),
        leave_policies: [],
      });
      order.push(employeeId);
    }
    byEmployeeId.get(employeeId).leave_policies.push(mapLeavePolicyBalance(row));
  }

  return order.map((employeeId) => byEmployeeId.get(employeeId));
}

async function getAuthenticatedEmployee(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id, employee_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const user = result.rows[0];
  if (user.role !== USER_ROLES.EMPLOYEE) {
    return { error: [403, 'Only an employee can perform this action.'] };
  }
  if (!user.is_active || !user.company_id || !user.employee_id) {
    return { error: [403, 'Your account must be active and linked to an employee profile.'] };
  }
  return { user, employeeId: Number(user.employee_id), companyId: Number(user.company_id) };
}

async function fetchLeaveBalanceById(balanceId, companyId) {
  const result = await pool.query(
    `SELECT ${BALANCE_SELECT}
     ${BALANCE_FROM}
     WHERE lb.id = $1 AND lb.company_id = $2`,
    [balanceId, companyId]
  );
  return result.rows[0] || null;
}

function buildListFilters(query, companyId, values, startIdx = 2) {
  const filters = [`lb.company_id = $1`];
  let idx = startIdx;

  const yearResult = normalizeYear(query?.year);
  if (yearResult.error) return { error: yearResult.error };
  if (yearResult.value !== null) {
    filters.push(`lb.year = $${idx++}`);
    values.push(yearResult.value);
  }

  const employeeId = parsePositiveInt(query?.employee_id);
  if (query?.employee_id !== undefined && !employeeId) {
    return { error: 'employee_id must be a positive integer.' };
  }
  if (employeeId) {
    filters.push(`lb.employee_id = $${idx++}`);
    values.push(employeeId);
  }

  const leavePolicyId = parsePositiveInt(query?.leave_policy_id);
  if (query?.leave_policy_id !== undefined && !leavePolicyId) {
    return { error: 'leave_policy_id must be a positive integer.' };
  }
  if (leavePolicyId) {
    filters.push(`lb.leave_policy_id = $${idx++}`);
    values.push(leavePolicyId);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(
      e.first_name ILIKE $${idx}
      OR e.last_name ILIKE $${idx}
      OR COALESCE(e.employee_code, '') ILIKE $${idx}
      OR lp.name ILIKE $${idx}
      OR lp.code ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return { whereSql: filters.join(' AND '), nextIdx: idx, year: yearResult.value };
}

function buildMyBalanceFilters(query, companyId, employeeId, values) {
  const hasExplicitYear = query?.year !== undefined && query?.year !== null && String(query.year).trim() !== '';
  const yearResult = normalizeYear(query?.year, hasExplicitYear ? null : new Date().getUTCFullYear());
  if (yearResult.error) return { error: yearResult.error };

  const filters = ['lb.company_id = $1', 'lb.employee_id = $2'];
  values.push(companyId, employeeId);
  let idx = 3;

  if (hasExplicitYear) {
    filters.push(`lb.year = $${idx++}`);
    values.push(yearResult.value);
  } else {
    // Active anniversary period covering today, or legacy calendar-year row for current year.
    filters.push(`(
      (
        lb.period_start IS NOT NULL
        AND COALESCE(lb.cycle_status, 'active') = 'active'
        AND (CURRENT_DATE AT TIME ZONE 'UTC')::date BETWEEN lb.period_start AND lb.period_end
      )
      OR (
        lb.period_start IS NULL
        AND lb.year = $${idx++}
      )
    )`);
    values.push(yearResult.value);
  }

  const leavePolicyId = parsePositiveInt(query?.leave_policy_id);
  if (query?.leave_policy_id !== undefined && !leavePolicyId) {
    return { error: 'leave_policy_id must be a positive integer.' };
  }
  if (leavePolicyId) {
    filters.push(`lb.leave_policy_id = $${idx++}`);
    values.push(leavePolicyId);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(lp.name ILIKE $${idx} OR lp.code ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return {
    whereSql: filters.join(' AND '),
    nextIdx: idx,
    year: yearResult.value,
    leavePolicyId: leavePolicyId || null,
    search: search || null,
  };
}

async function getMyLeaveBalances(authUser, query) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query);
  if (sort.error) return { error: [400, sort.error] };

  const values = [];
  const filterResult = buildMyBalanceFilters(query, auth.companyId, auth.employeeId, values);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const whereSql = filterResult.whereSql;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     ${BALANCE_FROM}
     WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${BALANCE_SELECT}
     ${BALANCE_FROM}
     WHERE ${whereSql}
     ORDER BY ${sort.orderBySql}`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${filterResult.nextIdx} OFFSET $${filterResult.nextIdx + 1}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    year: filterResult.year,
    leave_balances: result.rows.map((row) => mapLeaveBalanceRow(row)),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      year: filterResult.year,
      leave_policy_id: filterResult.leavePolicyId,
      search: filterResult.search,
    },
  };
}

async function getLeaveBalances(companyId, query) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query, { grouped: true });
  if (sort.error) return { error: [400, sort.error] };

  const values = [companyId];
  const filterResult = buildListFilters(query, companyId, values);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const whereSql = filterResult.whereSql;

  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT lb.employee_id)::int AS total
     ${BALANCE_FROM}
     WHERE ${whereSql}`,
    values
  );

  const employeeIdsSql = `SELECT lb.employee_id AS employee_id
     ${BALANCE_FROM}
     WHERE ${whereSql}
     GROUP BY lb.employee_id
     ORDER BY ${sort.orderBySql}`;

  const employeeIdsResult = listPagination.noPagination
    ? await pool.query(employeeIdsSql, values)
    : await pool.query(
        `${employeeIdsSql} LIMIT $${filterResult.nextIdx} OFFSET $${filterResult.nextIdx + 1}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  const employeeIds = employeeIdsResult.rows.map((row) => Number(row.employee_id));

  let employees = [];
  if (employeeIds.length > 0) {
    const employeeIdsParamIdx = filterResult.nextIdx;
    const detailResult = await pool.query(
      `SELECT ${BALANCE_SELECT}
       ${BALANCE_FROM}
       WHERE ${whereSql} AND lb.employee_id = ANY($${employeeIdsParamIdx}::int[])
       ORDER BY array_position($${employeeIdsParamIdx}::int[], lb.employee_id), lp.name ASC`,
      [...values, employeeIds]
    );
    employees = groupBalanceRowsByEmployee(detailResult.rows);
  }

  return {
    employees,
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      year: filterResult.year,
      employee_id: parsePositiveInt(query?.employee_id) || null,
      leave_policy_id: parsePositiveInt(query?.leave_policy_id) || null,
      search: query?.search ? String(query.search).trim() : null,
    },
  };
}

async function getLeaveBalanceById(balanceId, companyId) {
  const row = await fetchLeaveBalanceById(balanceId, companyId);
  if (!row) return { error: [404, 'Leave balance not found.'] };
  return { leave_balance: mapLeaveBalanceRow(row, { includeEmployee: true }) };
}

async function updateLeaveBalance(balanceId, companyId, body) {
  const allowedKeys = new Set(['total_days', 'used_days']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }

  const hasTotal = Object.prototype.hasOwnProperty.call(body, 'total_days');
  const hasUsed = Object.prototype.hasOwnProperty.call(body, 'used_days');
  if (!hasTotal && !hasUsed) {
    return { error: [400, 'Provide total_days and/or used_days to update.'] };
  }

  const existing = await fetchLeaveBalanceById(balanceId, companyId);
  if (!existing) return { error: [404, 'Leave balance not found.'] };

  let totalDays = Number(existing.total_days);
  let usedDays = Number(existing.used_days);

  if (hasTotal) {
    const totalResult = normalizeDays(body.total_days, 'total_days');
    if (totalResult.error) return { error: [400, totalResult.error] };
    totalDays = totalResult.value;
  }
  if (hasUsed) {
    const usedResult = normalizeDays(body.used_days, 'used_days');
    if (usedResult.error) return { error: [400, usedResult.error] };
    usedDays = usedResult.value;
  }

  if (usedDays > totalDays) {
    return { error: [400, 'used_days cannot be greater than total_days.'] };
  }

  const availableDays = Math.round((totalDays - usedDays) * 100) / 100;
  const nowUtc = utcNowForPgTimestamp();

  const updated = await pool.query(
    `UPDATE leave_balances
     SET total_days = $1,
         used_days = $2,
         available_days = $3,
         updated_at = $4::timestamp
     WHERE id = $5 AND company_id = $6
     RETURNING id`,
    [totalDays, usedDays, availableDays, nowUtc, balanceId, companyId]
  );

  if (updated.rowCount === 0) return { error: [404, 'Leave balance not found.'] };

  const row = await fetchLeaveBalanceById(balanceId, companyId);

  const totalChanged = hasTotal && Number(existing.total_days) !== totalDays;
  const usedChanged = hasUsed && Number(existing.used_days) !== usedDays;
  if (totalChanged || usedChanged) {
    leaveEmailNotification
      .notifyLeaveBalanceUpdated(companyId, row, {
        previousAvailable: Number(existing.available_days),
        previousUsed: Number(existing.used_days),
        previousTotal: Number(existing.total_days),
      })
      .catch((error) => {
        console.error('Leave balance updated email error:', error);
      });
  }

  return { leave_balance: mapLeaveBalanceRow(row, { includeEmployee: true }) };
}

async function deleteLeaveBalance(balanceId, companyId) {
  const existing = await fetchLeaveBalanceById(balanceId, companyId);
  if (!existing) return { error: [404, 'Leave balance not found.'] };

  await pool.query(`DELETE FROM leave_balances WHERE id = $1 AND company_id = $2`, [
    balanceId,
    companyId,
  ]);

  return { leave_balance: mapLeaveBalanceRow(existing, { includeEmployee: true }) };
}

/**
 * Locks and deducts an employee's leave balance for an approved request. Shared by the default
 * admin-approval path and the configurable approval workflow engine so both apply identical
 * balance rules. Must run inside the caller's transaction (client). Returns { balanceBeforeApproval }
 * on success, or { error } if there's no balance row or insufficient available days.
 *
 * Prefers an active anniversary cycle covering leaveDateKey; falls back to legacy calendar year.
 */
async function deductBalanceForApprovedLeave(
  client,
  employeeId,
  leavePolicyId,
  year,
  billableDays,
  nowUtc,
  leaveDateKey = null
) {
  if (billableDays <= 0) return { balanceBeforeApproval: null };

  const dateKey = toDateOnlyString(leaveDateKey) || `${year}-01-01`;
  const balanceResult = await client.query(
    `SELECT id, total_days, used_days, available_days FROM leave_balances
     WHERE employee_id = $1
       AND leave_policy_id = $2
       AND COALESCE(cycle_status, 'active') = 'active'
       AND (
         (period_start IS NOT NULL AND $3::date BETWEEN period_start AND period_end)
         OR (period_start IS NULL AND year = $4)
       )
     ORDER BY period_start DESC NULLS LAST, id DESC
     LIMIT 1
     FOR UPDATE`,
    [employeeId, leavePolicyId, dateKey, year]
  );
  if (balanceResult.rowCount === 0) {
    return { error: 'No leave balance found for this employee/policy/year. Cannot approve.' };
  }
  if (Number(balanceResult.rows[0].available_days) < billableDays) {
    return {
      error: `Insufficient leave balance. Available: ${balanceResult.rows[0].available_days}, Billable days after excluding holidays: ${billableDays}.`,
    };
  }

  const balanceBeforeApproval = balanceResult.rows[0];
  await client.query(
    `UPDATE leave_balances
     SET used_days = used_days + $1,
         available_days = available_days - $1,
         updated_at = $2::timestamp
     WHERE id = $3`,
    [billableDays, nowUtc, balanceResult.rows[0].id]
  );
  return { balanceBeforeApproval };
}

module.exports = {
  getAuthenticatedCompanyAdmin,
  getAuthenticatedEmployee,
  parsePositiveInt,
  getMyLeaveBalances,
  getLeaveBalances,
  getLeaveBalanceById,
  updateLeaveBalance,
  deleteLeaveBalance,
  grantActivePolicyBalancesForEmployee,
  deductBalanceForApprovedLeave,
};
