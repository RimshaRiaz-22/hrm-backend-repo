const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { utcNowForPgTimestamp, toUtcIsoString } = require('../utils/dateTime');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { roundMoney } = require('./loanRequest.service');

const DEFAULT_EMPLOYEE_PF_RATE = 8.33;
const DEFAULT_EMPLOYER_PF_RATE = 8.33;
const MONTH_REGEX = /^\d{4}-\d{2}$/;

const PF_ENROLL_ROLES = new Set([USER_ROLES.SUPER_ADMIN, USER_ROLES.COMPANY_ADMIN]);

const PF_ADMIN_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
]);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseContributionRate(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return roundMoney(n);
}

function parseOptionalContributionRate(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { provided: false };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    return { error: 'Contribution rates must be between 0 and 100.' };
  }
  return { provided: true, value: roundMoney(n) };
}

async function getEmployeeBasicSalary(client, employeeId) {
  const result = await client.query(
    `SELECT ejd.salary
     FROM employee_job_details ejd
     WHERE ejd.employee_id = $1`,
    [employeeId]
  );
  const salary = result.rows[0]?.salary;
  if (salary == null || Number(salary) <= 0) return null;
  return roundMoney(salary);
}

function mapPfAccountRow(row) {
  if (!row) return null;
  return {
    employee_id: Number(row.employee_id),
    company_id: Number(row.company_id),
    employee_name: row.employee_name || null,
    employee_code: row.employee_code || null,
    employee_email: row.work_email || null,
    basic_salary: row.basic_salary != null ? Number(row.basic_salary) : null,
    is_enrolled: Boolean(row.is_enrolled),
    balance: row.balance != null ? Number(row.balance) : 0,
    employee_contribution_rate:
      row.employee_contribution_rate != null
        ? Number(row.employee_contribution_rate)
        : DEFAULT_EMPLOYEE_PF_RATE,
    employer_contribution_rate:
      row.employer_contribution_rate != null
        ? Number(row.employer_contribution_rate)
        : DEFAULT_EMPLOYER_PF_RATE,
    enrolled_at: row.enrolled_at ? toUtcIsoString(row.enrolled_at) : null,
    enrolled_by: row.enrolled_by ? Number(row.enrolled_by) : null,
  };
}

const PF_ACCOUNT_SELECT = `
  SELECT e.id AS employee_id,
         e.company_id,
         e.first_name || ' ' || e.last_name AS employee_name,
         e.employee_code,
         e.work_email,
         ejd.salary AS basic_salary,
         epb.balance,
         epb.is_enrolled,
         epb.employee_contribution_rate,
         epb.employer_contribution_rate,
         epb.enrolled_at,
         epb.enrolled_by
  FROM employees e
  LEFT JOIN employee_pf_balances epb ON epb.employee_id = e.id
  LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
`;

async function isPfEnabledForEmployee(employeeId, db = pool) {
  const parsedEmployeeId = Number(employeeId);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) {
    return false;
  }

  const result = await db.query(
    `SELECT is_enrolled
     FROM employee_pf_balances
     WHERE employee_id = $1`,
    [parsedEmployeeId]
  );
  return Boolean(result.rows[0]?.is_enrolled);
}

function mapPfAccountSummary(row) {
  if (!row || !row.is_enrolled) {
    return { pf_enabled: false, pf_account: null };
  }
  return {
    pf_enabled: true,
    pf_account: {
      balance: row.balance != null ? Number(row.balance) : 0,
      employee_contribution_rate:
        row.employee_contribution_rate != null
          ? Number(row.employee_contribution_rate)
          : DEFAULT_EMPLOYEE_PF_RATE,
      employer_contribution_rate:
        row.employer_contribution_rate != null
          ? Number(row.employer_contribution_rate)
          : DEFAULT_EMPLOYER_PF_RATE,
    },
  };
}

async function getEmployeePfDetailsForProfile(employeeId, db = pool) {
  const parsedEmployeeId = Number(employeeId);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) {
    return { pf_enabled: false, pf_account: null };
  }

  const result = await db.query(
    `SELECT balance, is_enrolled, employee_contribution_rate, employer_contribution_rate
     FROM employee_pf_balances
     WHERE employee_id = $1`,
    [parsedEmployeeId]
  );
  return mapPfAccountSummary(result.rows[0] || null);
}

async function getPfAccountRow(client, employeeId, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE OF epb' : '';
  const result = await client.query(
    `SELECT epb.id, epb.balance, epb.is_enrolled, epb.company_id,
            epb.employee_contribution_rate, epb.employer_contribution_rate
     FROM employee_pf_balances epb
     WHERE epb.employee_id = $1${lock}`,
    [employeeId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    balance: Number(row.balance),
    is_enrolled: Boolean(row.is_enrolled),
    employee_contribution_rate: Number(row.employee_contribution_rate),
    employer_contribution_rate: Number(row.employer_contribution_rate),
  };
}

async function assertEnrolledPfAccount(client, employeeId, { forUpdate = false } = {}) {
  const row = await getPfAccountRow(client, employeeId, { forUpdate });
  if (!row) {
    return { error: 'PF account is not enabled for this employee.', status: 403 };
  }
  if (!row.is_enrolled) {
    return { error: 'PF account is not enabled for this employee.', status: 403 };
  }
  return { account: row };
}

async function applyBalanceChange(
  client,
  {
    companyId,
    employeeId,
    entryType,
    amount,
    referenceType = null,
    referenceId = null,
    notes = null,
    recordedBy = null,
  }
) {
  const enrolled = await assertEnrolledPfAccount(client, employeeId, { forUpdate: true });
  if (enrolled.error) return enrolled;

  const normalizedAmount = roundMoney(amount);
  if (!normalizedAmount || normalizedAmount <= 0) {
    return { error: 'PF balance change amount must be positive.', status: 400 };
  }

  let newBalance = enrolled.account.balance;

  if (entryType === 'credit' || entryType === 'adjustment') {
    newBalance = roundMoney(enrolled.account.balance + normalizedAmount);
  } else if (entryType === 'debit') {
    if (normalizedAmount > enrolled.account.balance) {
      return { error: 'Insufficient PF balance.', status: 400 };
    }
    newBalance = roundMoney(enrolled.account.balance - normalizedAmount);
  } else {
    return { error: 'Invalid PF ledger entry type.', status: 400 };
  }

  const now = utcNowForPgTimestamp();

  await client.query(
    `UPDATE employee_pf_balances
     SET balance = $1, updated_at = $2
     WHERE employee_id = $3`,
    [newBalance, now, employeeId]
  );

  await client.query(
    `INSERT INTO employee_pf_ledger (
       company_id, employee_id, entry_type, amount, balance_after,
       reference_type, reference_id, notes, recorded_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      companyId,
      employeeId,
      entryType,
      normalizedAmount,
      newBalance,
      referenceType,
      referenceId,
      notes,
      recordedBy,
    ]
  );

  return { balance: newBalance };
}

async function getEmployeePfBalance(employeeId) {
  const result = await pool.query(`${PF_ACCOUNT_SELECT} WHERE e.id = $1`, [employeeId]);

  if (!result.rows[0]) {
    return { error: 'Employee not found.', status: 404 };
  }

  const data = mapPfAccountRow(result.rows[0]);
  if (!data.is_enrolled) {
    return { error: 'PF account is not enabled for this employee.', status: 403 };
  }

  return { data };
}

async function getEmployeePfBalanceForAdmin(auth, employeeId) {
  const userResult = await pool.query(
    `SELECT id, role, company_id, is_active FROM users WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (!userResult.rows[0]?.is_active) {
    return { error: 'Your account is inactive.', status: 403 };
  }
  if (!PF_ADMIN_ROLES.has(userResult.rows[0].role)) {
    return { error: 'You do not have permission to view employee PF balances.', status: 403 };
  }

  const result = await pool.query(`${PF_ACCOUNT_SELECT} WHERE e.id = $1`, [employeeId]);
  if (!result.rows[0]) {
    return { error: 'Employee not found.', status: 404 };
  }

  const data = mapPfAccountRow(result.rows[0]);
  if (
    userResult.rows[0].role !== USER_ROLES.SUPER_ADMIN &&
    Number(userResult.rows[0].company_id) !== Number(data.company_id)
  ) {
    return { error: 'Employee does not belong to your company.', status: 403 };
  }

  return { data };
}

async function getEnrollAdminContext(auth) {
  const result = await pool.query(
    `SELECT id, role, company_id, is_active FROM users WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!PF_ENROLL_ROLES.has(user.role)) {
    return { error: 'Only company admin can enable PF accounts.', status: 403 };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.', status: 403 };
  }
  return { user };
}

async function enrollPfAccount(auth, body) {
  const adminCtx = await getEnrollAdminContext(auth);
  if (adminCtx.error) return { error: adminCtx.error, status: 403 };

  const employeeId = parsePositiveInt(body?.employee_id);
  if (!employeeId) {
    return { error: 'employee_id must be a positive integer.', status: 400 };
  }

  const employeeRate = parseContributionRate(
    body?.employee_contribution_rate,
    DEFAULT_EMPLOYEE_PF_RATE
  );
  const employerRate = parseContributionRate(
    body?.employer_contribution_rate,
    DEFAULT_EMPLOYER_PF_RATE
  );
  if (!employeeRate || !employerRate) {
    return { error: 'Contribution rates must be between 0 and 100.', status: 400 };
  }

  if (
    body?.opening_balance === undefined ||
    body?.opening_balance === null ||
    String(body.opening_balance).trim() === ''
  ) {
    return { error: 'opening_balance is required.', status: 400 };
  }
  const openingBalance = roundMoney(body.opening_balance);
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    return { error: 'opening_balance must be a non-negative number.', status: 400 };
  }

  const employeeResult = await pool.query(
    `SELECT e.id, e.company_id, ejd.salary
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.id = $1`,
    [employeeId]
  );
  if (!employeeResult.rows[0]) {
    return { error: 'Employee not found.', status: 404 };
  }

  const employee = employeeResult.rows[0];
  const companyId = Number(employee.company_id);
  if (
    adminCtx.user.role !== USER_ROLES.SUPER_ADMIN &&
    Number(adminCtx.user.company_id) !== companyId
  ) {
    return { error: 'Employee does not belong to your company.', status: 403 };
  }

  if (employee.salary == null || Number(employee.salary) <= 0) {
    return {
      error: 'Employee basic salary must be configured before enabling PF.',
      status: 400,
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, is_enrolled FROM employee_pf_balances WHERE employee_id = $1 FOR UPDATE`,
      [employeeId]
    );

    if (existing.rows[0]?.is_enrolled) {
      await client.query('ROLLBACK');
      return { error: 'PF account is already enabled for this employee.', status: 409 };
    }

    const now = utcNowForPgTimestamp();

    if (existing.rows[0]) {
      await client.query(
        `UPDATE employee_pf_balances
         SET is_enrolled = TRUE,
             employee_contribution_rate = $1,
             employer_contribution_rate = $2,
             balance = $3,
             enrolled_at = $4,
             enrolled_by = $5,
             updated_at = $4
         WHERE employee_id = $6`,
        [employeeRate, employerRate, openingBalance, now, adminCtx.user.id, employeeId]
      );
    } else {
      await client.query(
        `INSERT INTO employee_pf_balances (
           company_id, employee_id, balance, is_enrolled,
           employee_contribution_rate, employer_contribution_rate,
           enrolled_at, enrolled_by
         )
         VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7)`,
        [companyId, employeeId, openingBalance, employeeRate, employerRate, now, adminCtx.user.id]
      );
    }

    if (openingBalance > 0) {
      await client.query(
        `INSERT INTO employee_pf_ledger (
           company_id, employee_id, entry_type, amount, balance_after,
           reference_type, notes, recorded_by
         )
         VALUES ($1, $2, 'credit', $3, $3, 'opening_balance', $4, $5)`,
        [
          companyId,
          employeeId,
          openingBalance,
          'Opening PF balance on enrollment',
          adminCtx.user.id,
        ]
      );
    }

    await client.query('COMMIT');

    const detail = await pool.query(`${PF_ACCOUNT_SELECT} WHERE e.id = $1`, [employeeId]);
    return { data: mapPfAccountRow(detail.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updatePfAccountRates(auth, employeeIdParam, body) {
  const adminCtx = await getEnrollAdminContext(auth);
  if (adminCtx.error) {
    return { error: adminCtx.error, status: adminCtx.status || 403 };
  }

  const employeeId = parsePositiveInt(employeeIdParam);
  if (!employeeId) {
    return { error: 'employee_id must be a positive integer.', status: 400 };
  }

  const employeeRateParsed = parseOptionalContributionRate(body?.employee_contribution_rate);
  if (employeeRateParsed.error) {
    return { error: employeeRateParsed.error, status: 400 };
  }
  const employerRateParsed = parseOptionalContributionRate(body?.employer_contribution_rate);
  if (employerRateParsed.error) {
    return { error: employerRateParsed.error, status: 400 };
  }
  if (!employeeRateParsed.provided && !employerRateParsed.provided) {
    return {
      error: 'At least one of employee_contribution_rate or employer_contribution_rate is required.',
      status: 400,
    };
  }

  const employeeResult = await pool.query(
    `SELECT id, company_id FROM employees WHERE id = $1`,
    [employeeId]
  );
  if (!employeeResult.rows[0]) {
    return { error: 'Employee not found.', status: 404 };
  }

  const companyId = Number(employeeResult.rows[0].company_id);
  if (
    adminCtx.user.role !== USER_ROLES.SUPER_ADMIN &&
    Number(adminCtx.user.company_id) !== companyId
  ) {
    return { error: 'Employee does not belong to your company.', status: 403 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const enrolled = await assertEnrolledPfAccount(client, employeeId, { forUpdate: true });
    if (enrolled.error) {
      await client.query('ROLLBACK');
      return { error: enrolled.error, status: enrolled.status || 403 };
    }

    const employeeRate = employeeRateParsed.provided
      ? employeeRateParsed.value
      : enrolled.account.employee_contribution_rate;
    const employerRate = employerRateParsed.provided
      ? employerRateParsed.value
      : enrolled.account.employer_contribution_rate;

    const now = utcNowForPgTimestamp();
    await client.query(
      `UPDATE employee_pf_balances
       SET employee_contribution_rate = $1,
           employer_contribution_rate = $2,
           updated_at = $3
       WHERE employee_id = $4`,
      [employeeRate, employerRate, now, employeeId]
    );

    await client.query('COMMIT');

    const detail = await pool.query(`${PF_ACCOUNT_SELECT} WHERE e.id = $1`, [employeeId]);
    return { data: mapPfAccountRow(detail.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listPfAccounts(auth, query = {}) {
  const adminCtx = await getEnrollAdminContext(auth);
  if (adminCtx.error) {
    return { error: adminCtx.error, status: adminCtx.status || 403 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const conditions = [];
  const params = [];

  if (adminCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(adminCtx.user.company_id);
    conditions.push(`e.company_id = $${params.length}`);
  }

  const enrolledFilter = String(query.enrolled ?? query.pf_enrolled ?? 'all')
    .trim()
    .toLowerCase();
  if (enrolledFilter === 'true' || enrolledFilter === 'enrolled') {
    conditions.push(`epb.is_enrolled = TRUE`);
  } else if (enrolledFilter === 'false' || enrolledFilter === 'not_enrolled') {
    conditions.push(`(epb.id IS NULL OR epb.is_enrolled = FALSE)`);
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
      OR e.work_email ILIKE $${idx}
    )`);
  }

  const whereClause = conditions.length ? conditions.join(' AND ') : 'TRUE';
  const fromClause = `
    FROM employees e
    LEFT JOIN employee_pf_balances epb ON epb.employee_id = e.id
    LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
  `;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${fromClause} WHERE ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  let listSql = `
    SELECT e.id AS employee_id,
           e.company_id,
           e.first_name || ' ' || e.last_name AS employee_name,
           e.employee_code,
           e.work_email,
           ejd.salary AS basic_salary,
           epb.balance,
           COALESCE(epb.is_enrolled, FALSE) AS is_enrolled,
           epb.employee_contribution_rate,
           epb.employer_contribution_rate,
           epb.enrolled_at,
           epb.enrolled_by
    ${fromClause}
    WHERE ${whereClause}
    ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC
  `;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const listResult = await pool.query(listSql, listParams);
  const items = listResult.rows.map(mapPfAccountRow);

  return {
    data: {
      items,
      pagination: buildListPaginationMeta(total, pagination),
    },
  };
}

async function processPayrollRunContributions(
  client,
  { runId, companyId, periodMonth, recordedBy }
) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('A database transaction client is required.');
  }
  if (!parsePositiveInt(runId) || !parsePositiveInt(companyId)) {
    throw new Error('Valid payroll run and company ids are required.');
  }
  if (!MONTH_REGEX.test(String(periodMonth || ''))) {
    throw new Error('periodMonth must be in YYYY-MM format.');
  }

  const runEmployeesResult = await client.query(
    `SELECT pre.employee_id, pre.basic_salary,
            e.employee_code,
            TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS employee_name,
            epb.employee_contribution_rate, epb.employer_contribution_rate
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id AND e.company_id = $2
     JOIN employee_pf_balances epb
       ON epb.employee_id = pre.employee_id
      AND epb.company_id = $2
      AND epb.is_enrolled = TRUE
     WHERE pre.payroll_run_id = $1
     ORDER BY pre.employee_id`,
    [runId, companyId]
  );

  const processed = [];
  const skipped = [];

  for (const row of runEmployeesResult.rows) {
    const employeeId = Number(row.employee_id);
    const employeeInfo = {
      employee_id: employeeId,
      employee_code: row.employee_code || null,
      employee_name: row.employee_name || null,
    };

    const basicSalary = Number(row.basic_salary);
    if (!Number.isFinite(basicSalary) || basicSalary <= 0) {
      skipped.push({
        ...employeeInfo,
        reason: 'Basic salary is missing from the payroll run.',
      });
      continue;
    }

    const employeeRate = Number(row.employee_contribution_rate);
    const employerRate = Number(row.employer_contribution_rate);
    if (
      !Number.isFinite(employeeRate) ||
      employeeRate <= 0 ||
      employeeRate > 100 ||
      !Number.isFinite(employerRate) ||
      employerRate <= 0 ||
      employerRate > 100
    ) {
      skipped.push({
        ...employeeInfo,
        reason: 'PF employee or employer contribution rate is missing or invalid.',
      });
      continue;
    }

    const employeeAmount = roundMoney((basicSalary * employeeRate) / 100);
    const employerAmount = roundMoney((basicSalary * employerRate) / 100);
    const totalAmount = roundMoney(employeeAmount + employerAmount);
    if (totalAmount <= 0) {
      skipped.push({
        ...employeeInfo,
        reason: 'Calculated PF contribution is zero.',
      });
      continue;
    }

    const periodInsert = await client.query(
      `INSERT INTO employee_pf_contribution_periods (
         company_id, employee_id, period_month,
         employee_amount, employer_amount, total_amount, recorded_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (employee_id, period_month) DO NOTHING
       RETURNING id`,
      [
        companyId,
        employeeId,
        periodMonth,
        employeeAmount,
        employerAmount,
        totalAmount,
        recordedBy,
      ]
    );

    if (periodInsert.rowCount === 0) {
      skipped.push({
        ...employeeInfo,
        reason: 'PF contribution already processed for this month.',
      });
      continue;
    }

    const creditResult = await applyBalanceChange(client, {
      companyId,
      employeeId,
      entryType: 'credit',
      amount: totalAmount,
      referenceType: 'monthly_contribution',
      referenceId: runId,
      notes: `PF contribution for ${periodMonth} from payroll run #${runId} (employee ${employeeAmount} + employer ${employerAmount})`,
      recordedBy,
    });

    if (creditResult.error) {
      await client.query(
        `DELETE FROM employee_pf_contribution_periods
         WHERE id = $1`,
        [periodInsert.rows[0].id]
      );
      skipped.push({ ...employeeInfo, reason: creditResult.error });
      continue;
    }

    processed.push({
      ...employeeInfo,
      period_month: periodMonth,
      employee_amount: employeeAmount,
      employer_amount: employerAmount,
      total_amount: totalAmount,
      balance: creditResult.balance,
    });
  }

  return {
    period_month: periodMonth,
    processed_count: processed.length,
    skipped_count: skipped.length,
    processed,
    skipped,
  };
}

async function processMonthlyContributions(auth, body) {
  const adminCtx = await getEnrollAdminContext(auth);
  if (adminCtx.error) {
    return { error: adminCtx.error, status: adminCtx.status || 403 };
  }

  const periodMonth = String(body?.period_month || '').trim();
  if (!MONTH_REGEX.test(periodMonth)) {
    return { error: 'period_month must be in YYYY-MM format.', status: 400 };
  }

  const employeeId = body?.employee_id != null ? parsePositiveInt(body.employee_id) : null;
  if (body?.employee_id != null && !employeeId) {
    return { error: 'employee_id must be a positive integer.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [periodMonth];
    let companyFilter = '';
    if (adminCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(adminCtx.user.company_id);
      companyFilter = ` AND epb.company_id = $${params.length}`;
    }

    let employeeFilter = '';
    if (employeeId) {
      params.push(employeeId);
      employeeFilter = ` AND epb.employee_id = $${params.length}`;
    }

    const enrolledResult = await client.query(
      `SELECT epb.employee_id, epb.company_id, epb.employee_contribution_rate,
              epb.employer_contribution_rate, ejd.salary
       FROM employee_pf_balances epb
       JOIN employee_job_details ejd ON ejd.employee_id = epb.employee_id
       WHERE epb.is_enrolled = TRUE${companyFilter}${employeeFilter}`,
      params
    );

    const processed = [];
    const skipped = [];

    for (const row of enrolledResult.rows) {
      const empId = Number(row.employee_id);
      const companyId = Number(row.company_id);
      const basicSalary = Number(row.salary);

      if (!basicSalary || basicSalary <= 0) {
        skipped.push({ employee_id: empId, reason: 'Basic salary not configured.' });
        continue;
      }

      const existingPeriod = await client.query(
        `SELECT id FROM employee_pf_contribution_periods
         WHERE employee_id = $1 AND period_month = $2`,
        [empId, periodMonth]
      );
      if (existingPeriod.rows[0]) {
        skipped.push({ employee_id: empId, reason: 'Contribution already processed for this month.' });
        continue;
      }

      const employeeAmount = roundMoney(
        (basicSalary * Number(row.employee_contribution_rate)) / 100
      );
      const employerAmount = roundMoney(
        (basicSalary * Number(row.employer_contribution_rate)) / 100
      );
      const totalAmount = roundMoney(employeeAmount + employerAmount);

      const creditResult = await applyBalanceChange(client, {
        companyId,
        employeeId: empId,
        entryType: 'credit',
        amount: totalAmount,
        referenceType: 'monthly_contribution',
        notes: `PF contribution for ${periodMonth} (employee ${employeeAmount} + employer ${employerAmount})`,
        recordedBy: adminCtx.user.id,
      });

      if (creditResult.error) {
        skipped.push({ employee_id: empId, reason: creditResult.error });
        continue;
      }

      await client.query(
        `INSERT INTO employee_pf_contribution_periods (
           company_id, employee_id, period_month,
           employee_amount, employer_amount, total_amount, recorded_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          companyId,
          empId,
          periodMonth,
          employeeAmount,
          employerAmount,
          totalAmount,
          adminCtx.user.id,
        ]
      );

      processed.push({
        employee_id: empId,
        period_month: periodMonth,
        employee_amount: employeeAmount,
        employer_amount: employerAmount,
        total_amount: totalAmount,
        balance: creditResult.balance,
      });
    }

    await client.query('COMMIT');

    return {
      data: {
        period_month: periodMonth,
        processed_count: processed.length,
        skipped_count: skipped.length,
        processed,
        skipped,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function debitForPfTemporaryWithdrawal(client, params) {
  return applyBalanceChange(client, {
    ...params,
    entryType: 'debit',
    referenceType: 'pf_temporary_request',
  });
}

async function debitForPfPermanentWithdrawal(client, params) {
  return applyBalanceChange(client, {
    ...params,
    entryType: 'debit',
    referenceType: 'pf_permanent_withdrawal',
  });
}

async function creditForPfTemporaryReversal(client, params) {
  return applyBalanceChange(client, {
    ...params,
    entryType: 'credit',
    referenceType: 'pf_temporary_reversal',
    notes: params.notes || 'PF temporary approval reversed',
  });
}

async function creditForPfPermanentReversal(client, params) {
  return applyBalanceChange(client, {
    ...params,
    entryType: 'credit',
    referenceType: 'pf_permanent_reversal',
    notes: params.notes || 'PF permanent approval reversed',
  });
}

async function creditForPfRepayment(client, params) {
  return applyBalanceChange(client, {
    ...params,
    entryType: 'credit',
    referenceType: 'pf_temporary_repayment',
    notes: params.notes || 'PF temporary repayment',
  });
}

module.exports = {
  DEFAULT_EMPLOYEE_PF_RATE,
  DEFAULT_EMPLOYER_PF_RATE,
  PF_ENROLL_ROLES,
  PF_ADMIN_ROLES,
  assertEnrolledPfAccount,
  isPfEnabledForEmployee,
  getEmployeePfDetailsForProfile,
  getPfAccountRow,
  getEmployeePfBalance,
  getEmployeePfBalanceForAdmin,
  enrollPfAccount,
  updatePfAccountRates,
  listPfAccounts,
  processPayrollRunContributions,
  processMonthlyContributions,
  applyBalanceChange,
  debitForPfTemporaryWithdrawal,
  debitForPfPermanentWithdrawal,
  creditForPfTemporaryReversal,
  creditForPfPermanentReversal,
  creditForPfRepayment,
};
