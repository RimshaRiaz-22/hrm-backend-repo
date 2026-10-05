const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { loadLoanPaymentsMap } = require('./loanRequest.service');
const { toUtcIsoString } = require('../utils/dateTime');
const { PF_ADMIN_ROLES } = require('./pfBalance.service');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function getPfAdminContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!PF_ADMIN_ROLES.has(user.role)) {
    return { error: 'You do not have permission to view PF recoveries.' };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.' };
  }
  return { user };
}

function mapRecoveryRow(row) {
  return {
    loan_id: Number(row.loan_id),
    request_id: Number(row.request_id),
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_code: row.employee_code || null,
    amount: Number(row.amount),
    emi_amount: row.emi_amount != null ? Number(row.emi_amount) : null,
    tenure_months: row.tenure_months != null ? Number(row.tenure_months) : null,
    outstanding_balance: Number(row.outstanding_balance),
    recovery_method: row.recovery_method,
    status: row.status,
    start_month: row.start_month || null,
    purpose: row.purpose || null,
    loan_taken_date: row.loan_taken_date
      ? String(row.loan_taken_date).slice(0, 10)
      : null,
    approved_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    created_at: toUtcIsoString(row.created_at),
  };
}

async function listPfRecoveries(auth, query = {}) {
  const adminCtx = await getPfAdminContext(auth);
  if (adminCtx.error) {
    return { error: adminCtx.error, status: 403 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const conditions = [`l.loan_source = 'pf_temporary'`];
  const params = [];

  const status = String(query.status || 'all').trim().toLowerCase();
  if (status !== 'all') {
    if (!['active', 'closed'].includes(status)) {
      return { error: 'status must be active, closed, or all.', status: 400 };
    }
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }

  const recoveryMethod = String(query.recovery_method || '').trim().toLowerCase();
  if (recoveryMethod) {
    if (!['salary_deduction', 'cash'].includes(recoveryMethod)) {
      return { error: 'Invalid recovery_method filter.', status: 400 };
    }
    params.push(recoveryMethod);
    conditions.push(`l.recovery_method = $${params.length}`);
  }

  const employeeId = parsePositiveInt(query.employee_id);
  if (employeeId) {
    params.push(employeeId);
    conditions.push(`l.employee_id = $${params.length}`);
  }

  const search = String(query.search || '').trim();
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(`(
      e.first_name ILIKE $${idx}
      OR e.last_name ILIKE $${idx}
      OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${idx}
      OR e.employee_code ILIKE $${idx}
      OR ptd.purpose ILIKE $${idx}
    )`);
  }

  if (adminCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(adminCtx.user.company_id);
    conditions.push(`l.company_id = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');
  const fromClause = `
    FROM loans l
    JOIN requests r ON r.id = l.request_id
    JOIN employees e ON e.id = l.employee_id
    JOIN pf_temporary_request_details ptd ON ptd.request_id = l.request_id
  `;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${fromClause} WHERE ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  let listSql = `
    SELECT l.id AS loan_id, l.request_id, l.employee_id, l.amount, l.emi_amount,
           l.tenure_months, l.outstanding_balance, l.recovery_method, l.status,
           l.start_month, l.created_at,
           e.first_name || ' ' || e.last_name AS employee_name,
           e.employee_code,
           ptd.purpose, ptd.loan_taken_date,
           r.reviewed_at
    ${fromClause}
    WHERE ${whereClause}
    ORDER BY l.created_at DESC, l.id DESC
  `;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const listResult = await pool.query(listSql, listParams);
  const items = listResult.rows.map(mapRecoveryRow);

  return {
    data: {
      items,
      pagination: buildListPaginationMeta(total, pagination),
    },
  };
}

async function listMyPfRecoveries(auth, query = {}) {
  const { getEmployeeIdFromAuth } = require('../utils/employeeAuth');
  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const conditions = [`l.loan_source = 'pf_temporary'`, `l.employee_id = $1`];
  const params = [employeeId];

  const status = String(query.status || 'all').trim().toLowerCase();
  if (status !== 'all') {
    if (!['active', 'closed'].includes(status)) {
      return { error: 'status must be active, closed, or all.', status: 400 };
    }
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');
  const fromClause = `
    FROM loans l
    JOIN requests r ON r.id = l.request_id
    JOIN employees e ON e.id = l.employee_id
    JOIN pf_temporary_request_details ptd ON ptd.request_id = l.request_id
  `;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${fromClause} WHERE ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  let listSql = `
    SELECT l.id AS loan_id, l.request_id, l.employee_id, l.amount, l.emi_amount,
           l.tenure_months, l.outstanding_balance, l.recovery_method, l.status,
           l.start_month, l.created_at,
           e.first_name || ' ' || e.last_name AS employee_name,
           e.employee_code,
           ptd.purpose, ptd.loan_taken_date,
           r.reviewed_at
    ${fromClause}
    WHERE ${whereClause}
    ORDER BY l.created_at DESC, l.id DESC
  `;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const listResult = await pool.query(listSql, listParams);
  const loanIds = listResult.rows.map((row) => Number(row.loan_id));
  const paymentsMap = await loadLoanPaymentsMap(loanIds);

  const items = listResult.rows.map((row) => {
    const recovery = mapRecoveryRow(row);
    recovery.payments = paymentsMap.get(recovery.loan_id) || [];
    return recovery;
  });

  return {
    data: {
      items,
      pagination: buildListPaginationMeta(total, pagination),
    },
  };
}

async function getPfRecoveryById(auth, loanId) {
  const adminCtx = await getPfAdminContext(auth);
  if (adminCtx.error) {
    return { error: adminCtx.error, status: 403 };
  }

  const id = parsePositiveInt(loanId);
  if (!id) {
    return { error: 'Invalid recovery id.', status: 400 };
  }

  const params = [id];
  let companyFilter = '';
  if (adminCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(adminCtx.user.company_id);
    companyFilter = ` AND l.company_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT l.id AS loan_id, l.request_id, l.employee_id, l.amount, l.emi_amount,
            l.tenure_months, l.outstanding_balance, l.recovery_method, l.status,
            l.start_month, l.created_at,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_code,
            ptd.purpose, ptd.loan_taken_date, ptd.pf_balance_before,
            r.reviewed_at
     FROM loans l
     JOIN requests r ON r.id = l.request_id
     JOIN employees e ON e.id = l.employee_id
     JOIN pf_temporary_request_details ptd ON ptd.request_id = l.request_id
     WHERE l.id = $1 AND l.loan_source = 'pf_temporary'${companyFilter}`,
    params
  );

  if (!result.rows[0]) {
    return { error: 'PF recovery not found.', status: 404 };
  }

  const paymentsMap = await loadLoanPaymentsMap([id]);
  const recovery = mapRecoveryRow(result.rows[0]);
  recovery.pf_balance_before =
    result.rows[0].pf_balance_before != null
      ? Number(result.rows[0].pf_balance_before)
      : null;
  recovery.payments = paymentsMap.get(id) || [];

  return { data: recovery };
}

module.exports = {
  listPfRecoveries,
  listMyPfRecoveries,
  getPfRecoveryById,
  PF_ADMIN_ROLES,
};
