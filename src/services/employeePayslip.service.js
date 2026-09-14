const pool = require('../db');
const { getAuthenticatedEmployeeContext, parsePositiveInt } = require('./documentAuth.service');
const { buildPayslipData } = require('./payslip/buildPayslipFromRun');
const { generatePayslipPdf, buildPayslipFilename } = require('./payslip/payslipPdf');
const { derivePayslipPassword } = require('./payslip/payslipPassword');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_RUN_TYPES = new Set(['all', 'regular', 'off_cycle']);

const PAYSLIP_LIST_SELECT = `SELECT pr.id AS payroll_run_id, pr.period_month, pr.pay_date, pr.is_off_cycle, pr.closed_at,
            ps.name AS schedule_name,
            pre.id AS payroll_run_employee_id, pre.basic_salary, pre.present_days, pre.absent_days,
            pre.total_allowances, pre.total_deductions, pre.total_contributions, pre.gross_pay, pre.net_pay,
            ejd.currency, c.currency AS company_currency`;

const PAYSLIP_LIST_FROM = `FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     JOIN employees e ON e.id = pre.employee_id
     LEFT JOIN payroll_schedules ps ON ps.id = pr.payroll_schedule_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN companies c ON c.id = e.company_id`;

function mapPayslipListRow(row) {
  return {
    payroll_run_id: Number(row.payroll_run_id),
    payroll_run_employee_id: Number(row.payroll_run_employee_id),
    period_month: row.period_month,
    pay_date: row.pay_date,
    is_off_cycle: Boolean(row.is_off_cycle),
    closed_at: row.closed_at,
    schedule_name: row.schedule_name || null,
    basic_salary: parseFloat(row.basic_salary),
    present_days: parseFloat(row.present_days),
    absent_days: parseFloat(row.absent_days),
    total_allowances: parseFloat(row.total_allowances),
    total_deductions: parseFloat(row.total_deductions),
    total_contributions: parseFloat(row.total_contributions),
    gross_pay: parseFloat(row.gross_pay),
    net_pay: parseFloat(row.net_pay),
    currency: String(row.currency || row.company_currency || 'PKR').trim() || 'PKR',
  };
}

function sanitizePayslipDataForApi(payslipData) {
  if (!payslipData || typeof payslipData !== 'object') return payslipData;
  const company = payslipData.company ? { ...payslipData.company } : null;
  if (company) delete company.logo_buffer;
  return {
    ...payslipData,
    company,
  };
}

function parseOptionalDateOnly(raw, fieldName) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null };
  }
  const value = String(raw).trim();
  if (!DATE_ONLY_REGEX.test(value)) {
    return { error: `${fieldName} must be YYYY-MM-DD.` };
  }
  return { value };
}

function parseRunTypeFilter(raw) {
  const value = String(raw || 'all')
    .trim()
    .toLowerCase();
  if (!VALID_RUN_TYPES.has(value)) {
    return { error: 'type must be one of: all, regular, off_cycle.' };
  }
  return { value };
}

function buildMyPayslipFilters(query, employeeId, companyId) {
  const filters = [
    'pre.employee_id = $1',
    'e.company_id = $2',
    "pr.status = 'closed'",
  ];
  const values = [employeeId, companyId];
  let idx = 3;

  const runTypeResult = parseRunTypeFilter(query?.type ?? query?.run_type);
  if (runTypeResult.error) return { error: runTypeResult.error };

  if (runTypeResult.value === 'regular') {
    filters.push('pr.is_off_cycle = FALSE');
  } else if (runTypeResult.value === 'off_cycle') {
    filters.push('pr.is_off_cycle = TRUE');
  }

  const payDateResult = parseOptionalDateOnly(
    query?.pay_date ?? query?.date,
    'pay_date'
  );
  if (payDateResult.error) return { error: payDateResult.error };
  if (payDateResult.value) {
    filters.push(`pr.pay_date = $${idx++}::date`);
    values.push(payDateResult.value);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(
      COALESCE(ps.name, '') ILIKE $${idx}
      OR COALESCE(pr.period_month, '') ILIKE $${idx}
      OR TO_CHAR(pr.pay_date, 'YYYY-MM-DD') ILIKE $${idx}
      OR TO_CHAR(pr.pay_date, 'Mon DD, YYYY') ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return {
    whereSql: filters.join(' AND '),
    nextIdx: idx,
    values,
  };
}

async function listMyPayslips(authUser, query = {}) {
  const auth = await getAuthenticatedEmployeeContext(authUser);
  if (auth.error) return { error: auth.error };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const filterResult = buildMyPayslipFilters(query, auth.employeeId, auth.companyId);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const { whereSql, values, nextIdx } = filterResult;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${PAYSLIP_LIST_FROM} WHERE ${whereSql}`,
    values
  );

  const listSql = `${PAYSLIP_LIST_SELECT}
     ${PAYSLIP_LIST_FROM}
     WHERE ${whereSql}
     ORDER BY pr.pay_date DESC NULLS LAST, pr.id DESC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    payslips: result.rows.map(mapPayslipListRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getMyPayslipDetail(authUser, runIdRaw) {
  const auth = await getAuthenticatedEmployeeContext(authUser);
  if (auth.error) return { error: auth.error };

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Payroll run id must be a positive integer.'] };

  const built = await buildPayslipData(auth.companyId, runId, auth.employeeId);
  if (built.error) return built;

  return {
    payslip: sanitizePayslipDataForApi(built.payslipData),
  };
}

async function getMyPayslipPdf(authUser, runIdRaw) {
  const auth = await getAuthenticatedEmployeeContext(authUser);
  if (auth.error) return { error: auth.error };

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Payroll run id must be a positive integer.'] };

  const built = await buildPayslipData(auth.companyId, runId, auth.employeeId);
  if (built.error) return built;

  const payslipData = built.payslipData;
  const passwordProtected = payslipData.payslip_password_protected === true;
  const password = passwordProtected
    ? derivePayslipPassword({
        employee_code: payslipData.employee?.employee_code || payslipData.employee_code,
        national_id: payslipData.national_id,
        email: payslipData.employee?.email,
      })
    : null;

  if (passwordProtected && !password) {
    return { error: [400, 'Could not derive payslip password for this employee.'] };
  }

  const pdfBuffer = await generatePayslipPdf(payslipData, { password });
  const filename = buildPayslipFilename(payslipData);

  return {
    pdfBuffer,
    filename,
    passwordProtected,
  };
}

module.exports = {
  listMyPayslips,
  getMyPayslipDetail,
  getMyPayslipPdf,
  buildMyPayslipFilters,
};
