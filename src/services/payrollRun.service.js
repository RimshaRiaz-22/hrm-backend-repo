const ExcelJS = require('exceljs');
const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { calculateEmployeePay, totalsFromLines, roundMoney } = require('./payrollCalc.service');
const { resolveEmployeeElements, getAuthenticatedCompanyAdmin, parsePositiveInt } = require('./payrollAssignment.service');
const { deriveDayAttendanceStatus, getEmployeeAttendanceProfile } = require('./attendancePunch.service');
const { getCompanyHolidayDateKeysForRange } = require('./holiday.service');
const { toDateKey } = require('../utils/dateTime');
const {
  periodDateKeysFromSchedule,
  normalizeWorkingDays,
  classifyPayrollDay,
  summarizePayrollAttendance,
  computeAbsenceDeductionAmount,
} = require('./sandwichRule.service');
const pfBalanceService = require('./pfBalance.service');

const VALID_LINE_KINDS = new Set([
  'basic',
  'allowance',
  'deduction',
  'contribution',
  'loan',
  'expense',
  'monthly_input',
  'absence',
]);
const VALID_ACTIONS = new Set(['post', 'approve', 'finalize', 'return', 'close']);
const VALID_STATUSES = new Set(['draft', 'pending', 'approved', 'finalized', 'closed']);

const TRANSITIONS = {
  post: { from: new Set(['draft']), to: 'pending' },
  approve: { from: new Set(['pending']), to: 'approved' },
  finalize: { from: new Set(['approved']), to: 'finalized' },
  return: { from: new Set(['pending', 'approved', 'finalized']), to: 'draft' },
  close: { from: new Set(['finalized']), to: 'closed' },
};

const RUN_COLUMNS = `pr.id, pr.company_id, pr.payroll_schedule_id, pr.is_off_cycle, pr.period_month,
  pr.pay_date, pr.status, pr.total_gross, pr.total_deductions, pr.total_net, pr.skipped_employees,
  pr.created_by, pr.closed_at, pr.created_at, pr.updated_at`;

const RUN_RETURNING_COLUMNS = `id, company_id, payroll_schedule_id, is_off_cycle, period_month,
  pay_date, status, total_gross, total_deductions, total_net, skipped_employees,
  created_by, closed_at, created_at, updated_at`;

const EMPLOYEE_COLUMNS = `pre.id, pre.payroll_run_id, pre.employee_id, pre.basic_salary, pre.present_days,
  pre.absent_days, pre.total_allowances, pre.total_deductions, pre.total_contributions,
  pre.gross_pay, pre.net_pay, pre.status, pre.created_at`;

function mapRunRow(row, extras = {}) {
  if (!row) return null;
  const skipped = row.skipped_employees;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    payroll_schedule_id: Number(row.payroll_schedule_id),
    schedule_name: row.schedule_name || extras.schedule_name || undefined,
    is_off_cycle: Boolean(row.is_off_cycle),
    period_month: row.period_month,
    pay_date: row.pay_date,
    status: row.status,
    total_gross: parseFloat(row.total_gross),
    total_deductions: parseFloat(row.total_deductions),
    total_net: parseFloat(row.total_net),
    skipped_employees: Array.isArray(skipped) ? skipped : [],
    skipped_count: Array.isArray(skipped) ? skipped.length : 0,
    employee_count: extras.employee_count ?? row.employee_count ?? undefined,
    created_by: row.created_by != null ? Number(row.created_by) : null,
    closed_at: row.closed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapEmployeeRow(row) {
  if (!row) return null;
  const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
  const totalExpenses =
    row.total_expenses != null ? parseFloat(row.total_expenses) : 0;
  return {
    id: Number(row.id),
    payroll_run_id: Number(row.payroll_run_id),
    employee_id: Number(row.employee_id),
    employee_name: name || undefined,
    basic_salary: parseFloat(row.basic_salary),
    present_days: parseFloat(row.present_days),
    absent_days: parseFloat(row.absent_days),
    total_allowances: parseFloat(row.total_allowances),
    total_expenses: Number.isFinite(totalExpenses) ? totalExpenses : 0,
    total_deductions: parseFloat(row.total_deductions),
    total_contributions: parseFloat(row.total_contributions),
    gross_pay: parseFloat(row.gross_pay),
    net_pay: parseFloat(row.net_pay),
    status: row.status,
    created_at: row.created_at,
  };
}

function mapLineRow(row) {
  return {
    id: Number(row.id),
    line_kind: row.line_kind,
    label: row.label,
    amount: parseFloat(row.amount),
    source_ref: row.source_ref || null,
  };
}

function parsePeriodMonth(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  return s;
}

function parseDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function workingDaysFromSchedule(schedule) {
  const start = Number(schedule.start_day) || 1;
  const end = Number(schedule.end_day) || 30;
  return Math.max(1, end - start + 1);
}

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchCompanyPayrollSettings(client, companyId) {
  const result = await client.query(
    `SELECT sandwich_rule, salary_method
     FROM companies
     WHERE id = $1`,
    [companyId]
  );
  const row = result.rows[0] || {};
  return {
    sandwich_rule: row.sandwich_rule === true,
    salary_method: row.salary_method || 'working_days',
  };
}

async function fetchApprovedLeaveByDate(client, employeeId, companyId, startDate, endDate) {
  const result = await client.query(
    `SELECT lr.from_date, lr.to_date, lp.paid_status
     FROM leave_requests lr
     JOIN leave_policies lp ON lp.id = lr.leave_policy_id
     WHERE lr.employee_id = $1
       AND lr.company_id = $2
       AND lr.status = 'approved'
       AND lr.to_date >= $3::date
       AND lr.from_date <= $4::date`,
    [employeeId, companyId, startDate, endDate]
  );

  const leaveByDate = new Map();
  for (const row of result.rows) {
    const fromKey = toDateKey(row.from_date);
    const toKey = toDateKey(row.to_date);
    if (!fromKey || !toKey) continue;
    const paidStatus = String(row.paid_status || '').toLowerCase() === 'paid' ? 'paid' : 'unpaid';
    let cursor = fromKey;
    while (cursor <= toKey) {
      if (cursor >= startDate && cursor <= endDate) {
        // Unpaid leave wins if multiple policies overlap the same day.
        const existing = leaveByDate.get(cursor);
        if (!existing || (existing === 'paid' && paidStatus === 'unpaid')) {
          leaveByDate.set(cursor, paidStatus);
        }
      }
      if (cursor === toKey) break;
      const [y, m, d] = cursor.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
        next.getUTCDate()
      ).padStart(2, '0')}`;
    }
  }
  return leaveByDate;
}

async function fetchEmployeePunchesByDate(client, employeeId, startDate, endDate) {
  const result = await client.query(
    `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
            work_location_id, latitude, longitude, remarks, attendance_status, created_at
     FROM attendance_punches
     WHERE employee_id = $1
       AND attendance_date >= $2
       AND attendance_date <= $3
     ORDER BY attendance_date ASC, punched_at ASC, id ASC`,
    [employeeId, startDate, endDate]
  );

  const punchesByDate = new Map();
  for (const row of result.rows) {
    const dateKey = toDateKey(row.attendance_date);
    if (!dateKey) continue;
    if (!punchesByDate.has(dateKey)) punchesByDate.set(dateKey, []);
    punchesByDate.get(dateKey).push(row);
  }
  return punchesByDate;
}

async function computeEmployeeAttendanceSummary(
  client,
  companyId,
  employeeId,
  schedule,
  periodMonth,
  companySettings,
  holidayDateKeys
) {
  const dateKeys = periodDateKeysFromSchedule(periodMonth, schedule);
  if (dateKeys.length === 0) {
    return {
      present_days: 0,
      absent_days: 0,
      scheduled_working_days: 0,
      calendar_days: 0,
      sandwich_absent_days: 0,
    };
  }

  const startDate = dateKeys[0];
  const endDate = dateKeys[dateKeys.length - 1];
  const todayKey = getTodayDateKey();

  const [profile, leaveByDate, punchesByDate] = await Promise.all([
    getEmployeeAttendanceProfile(client, employeeId),
    fetchApprovedLeaveByDate(client, employeeId, companyId, startDate, endDate),
    fetchEmployeePunchesByDate(client, employeeId, startDate, endDate),
  ]);

  const workingDays = normalizeWorkingDays(
    profile?.working_days || profile?.attendance_schedule?.working_days
  );

  const classifications = dateKeys.map((dateKey) => {
    const isHoliday = holidayDateKeys.has(dateKey);
    const leavePaidStatus = leaveByDate.get(dateKey) || null;
    const punches = punchesByDate.get(dateKey) || [];
    const attendanceStatus = profile
      ? deriveDayAttendanceStatus(profile, dateKey, punches)
      : 'absent';

    return classifyPayrollDay({
      dateKey,
      workingDays,
      isHoliday,
      leavePaidStatus,
      attendanceStatus,
      todayKey,
    });
  });

  return summarizePayrollAttendance({
    classifications,
    sandwichRuleEnabled: companySettings.sandwich_rule === true,
  });
}

function parseFilters(body = {}) {
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  const out = {};

  if (filters.department_id != null) {
    const id = parsePositiveInt(filters.department_id);
    if (!id) return { error: [400, 'filters.department_id must be a positive integer.'] };
    out.department_id = id;
  }

  if (filters.work_location_id != null) {
    const id = parsePositiveInt(filters.work_location_id);
    if (!id) return { error: [400, 'filters.work_location_id must be a positive integer.'] };
    out.work_location_id = id;
  }

  if (filters.employee_ids != null) {
    if (!Array.isArray(filters.employee_ids) || filters.employee_ids.length === 0) {
      return { error: [400, 'filters.employee_ids must be a non-empty array.'] };
    }
    const ids = [];
    for (const raw of filters.employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: [400, 'Each filters.employee_id must be a positive integer.'] };
      ids.push(id);
    }
    out.employee_ids = [...new Set(ids)];
  }

  return { filters: out };
}

function parseRunBody(body = {}) {
  const scheduleId = parsePositiveInt(body.payroll_schedule_id);
  if (!scheduleId) return { error: [400, 'payroll_schedule_id is required.'] };

  const periodMonth = parsePeriodMonth(body.period_month);
  if (!periodMonth) return { error: [400, 'period_month is required (YYYY-MM).'] };

  const payDate = parseDate(body.pay_date);
  if (!payDate) return { error: [400, 'pay_date is required (YYYY-MM-DD).'] };

  const isOffCycle = body.is_off_cycle === true || body.is_off_cycle === 'true';
  const filtersParsed = parseFilters(body);
  if (filtersParsed.error) return filtersParsed;

  return {
    payroll_schedule_id: scheduleId,
    period_month: periodMonth,
    pay_date: payDate,
    is_off_cycle: isOffCycle,
    filters: filtersParsed.filters,
  };
}

async function fetchSchedule(client, companyId, scheduleId) {
  const result = await client.query(
    `SELECT id, company_id, name, start_day, end_day
     FROM payroll_schedules
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
    [scheduleId, companyId]
  );
  return result.rows[0] || null;
}

async function findOpenRun(client, companyId, scheduleId, periodMonth, isOffCycle) {
  const result = await client.query(
    `SELECT id, status
     FROM payroll_runs
     WHERE company_id = $1
       AND payroll_schedule_id = $2
       AND period_month = $3
       AND is_off_cycle = $4
       AND status != 'closed'
     LIMIT 1`,
    [companyId, scheduleId, periodMonth, isOffCycle]
  );
  return result.rows[0] || null;
}

async function fetchCandidateEmployees(client, companyId, scheduleId, filters = {}) {
  const params = [companyId];
  const conditions = ['e.company_id = $1', "e.employment_status != 'exited'"];

  if (filters.department_id) {
    params.push(filters.department_id);
    conditions.push(`ejd.department_id = $${params.length}`);
  }
  if (filters.work_location_id) {
    params.push(filters.work_location_id);
    conditions.push(`ejd.work_location_id = $${params.length}`);
  }
  if (filters.employee_ids?.length) {
    params.push(filters.employee_ids);
    conditions.push(`e.id = ANY($${params.length}::bigint[])`);
  } else {
    params.push(scheduleId);
    conditions.push(`(ejd.payroll_schedule_id = $${params.length} OR ejd.payroll_schedule_id IS NULL)`);
  }

  const result = await client.query(
    `SELECT e.id, e.first_name, e.last_name, e.employment_status,
            ejd.salary, ejd.salary_template_id, ejd.payroll_schedule_id,
            ejd.department_id, ejd.work_location_id
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.first_name ASC, e.last_name ASC`,
    params
  );
  return result.rows;
}

async function fetchMonthlyInputs(client, companyId, employeeId, scheduleId, periodMonth, isOffCycle) {
  const result = await client.query(
    `SELECT id, pay_element_label, amount
     FROM monthly_inputs
     WHERE company_id = $1 AND employee_id = $2
       AND payroll_schedule_id = $3 AND period_month = $4
       AND is_off_cycle = $5 AND status = 'finalized'
       AND consumed_by_run_id IS NULL`,
    [companyId, employeeId, scheduleId, periodMonth, isOffCycle]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    pay_element_label: row.pay_element_label,
    amount: parseFloat(row.amount),
  }));
}

async function fetchLoans(client, companyId, employeeId, periodMonth) {
  const result = await client.query(
    `SELECT id, emi_amount, outstanding_balance, loan_source
     FROM loans
     WHERE company_id = $1 AND employee_id = $2
       AND status = 'active'
       AND recovery_method = 'salary_deduction'
       AND outstanding_balance > 0
       AND (start_month IS NULL OR start_month <= $3)`,
    [companyId, employeeId, periodMonth]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    emi_amount: parseFloat(row.emi_amount) || parseFloat(row.outstanding_balance),
    outstanding_balance: parseFloat(row.outstanding_balance),
    loan_source: row.loan_source || null,
    label:
      row.loan_source === 'advance'
        ? 'Advance Recovery'
        : row.loan_source === 'pf_temporary'
          ? 'PF Temporary Recovery'
          : 'Loan EMI',
  }));
}

async function fetchExpenses(client, companyId, employeeId, periodMonth) {
  const result = await client.query(
    `SELECT r.id, erd.total_amount, COALESCE(erd.category, 'Expense') AS label
     FROM requests r
     JOIN expense_request_details erd ON erd.request_id = r.id
     WHERE r.company_id = $1 AND r.employee_id = $2
       AND r.request_type = 'expense'
       AND r.status = 'approved'
       AND erd.paid_in = 'salary'
       AND erd.reimbursement_status = 'payable'
       AND (
         erd.reimbursement_month = $3
         OR (
           erd.reimbursement_month IS NULL
           AND TO_CHAR(
             COALESCE(erd.reimbursement_date, erd.payable_at)::date,
             'YYYY-MM'
           ) = $3
         )
       )`,
    [companyId, employeeId, periodMonth]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    amount: parseFloat(row.total_amount),
    label: row.label,
  }));
}

async function buildEmployeeCalculation(
  client,
  companyId,
  employee,
  schedule,
  periodMonth,
  isOffCycle,
  companySettings = { sandwich_rule: false, salary_method: 'working_days' },
  holidayDateKeys = new Set()
) {
  const employeeId = Number(employee.id);
  const name = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
  const runScheduleId = Number(schedule.id);

  if (!employee.payroll_schedule_id) {
    return { skipped: { employee_id: employeeId, employee_name: name, reason: 'No payroll schedule assigned' } };
  }

  if (Number(employee.payroll_schedule_id) !== runScheduleId) {
    return {
      skipped: {
        employee_id: employeeId,
        employee_name: name,
        reason: 'Payroll schedule does not match this run',
      },
    };
  }

  const basicSalary = parseFloat(employee.salary);
  if (!Number.isFinite(basicSalary) || basicSalary <= 0) {
    return { skipped: { employee_id: employeeId, employee_name: name, reason: 'No basic salary set' } };
  }

  const attendanceSummary = await computeEmployeeAttendanceSummary(
    client,
    companyId,
    employeeId,
    schedule,
    periodMonth,
    companySettings,
    holidayDateKeys
  );

  const workingDays =
    attendanceSummary.scheduled_working_days > 0
      ? attendanceSummary.scheduled_working_days
      : workingDaysFromSchedule(schedule);
  const presentDays =
    attendanceSummary.scheduled_working_days > 0
      ? attendanceSummary.present_days
      : workingDays;
  const absentDays = attendanceSummary.absent_days || 0;
  const absenceDeductionAmount = computeAbsenceDeductionAmount(
    basicSalary,
    absentDays,
    companySettings.salary_method,
    attendanceSummary
  );

  const { elements } = await resolveEmployeeElements(
    client,
    companyId,
    employeeId,
    employee.salary_template_id ? Number(employee.salary_template_id) : null
  );

  const monthlyInputs = await fetchMonthlyInputs(
    client,
    companyId,
    employeeId,
    Number(schedule.id),
    periodMonth,
    isOffCycle
  );
  const loans = await fetchLoans(client, companyId, employeeId, periodMonth);
  const expenses = await fetchExpenses(client, companyId, employeeId, periodMonth);

  const calculated = calculateEmployeePay({
    basicSalary,
    presentDays,
    absentDays,
    workingDays,
    absenceDeductionAmount,
    payElements: elements,
    monthlyInputs,
    loans,
    expenses,
  });

  return {
    employee_id: employeeId,
    employee_name: name,
    calculated,
  };
}

async function insertRunEmployee(client, runId, employeeId, calculated) {
  const empResult = await client.query(
    `INSERT INTO payroll_run_employees (
       payroll_run_id, employee_id, basic_salary, present_days, absent_days,
       total_allowances, total_deductions, total_contributions, gross_pay, net_pay, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
     RETURNING id`,
    [
      runId,
      employeeId,
      calculated.basic_salary,
      calculated.present_days,
      calculated.absent_days,
      calculated.total_allowances,
      calculated.total_deductions,
      calculated.total_contributions,
      calculated.gross_pay,
      calculated.net_pay,
    ]
  );

  const runEmployeeId = Number(empResult.rows[0].id);
  for (const line of calculated.lines) {
    await client.query(
      `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [runEmployeeId, line.line_kind, line.label, line.amount, line.source_ref || null]
    );
  }

  return runEmployeeId;
}

async function computeRunTotals(client, runId) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(gross_pay), 0) AS total_gross,
       COALESCE(SUM(total_deductions + total_contributions), 0) AS total_deductions,
       COALESCE(SUM(net_pay), 0) AS total_net
     FROM payroll_run_employees
     WHERE payroll_run_id = $1`,
    [runId]
  );
  return {
    total_gross: roundMoney(result.rows[0].total_gross),
    total_deductions: roundMoney(result.rows[0].total_deductions),
    total_net: roundMoney(result.rows[0].total_net),
  };
}

async function runCalculation(client, companyId, parsed, { persist = true, createdBy = null } = {}) {
  const schedule = await fetchSchedule(client, companyId, parsed.payroll_schedule_id);
  if (!schedule) return { error: [404, 'Payroll schedule not found.'] };

  if (persist) {
    const existing = await findOpenRun(
      client,
      companyId,
      parsed.payroll_schedule_id,
      parsed.period_month,
      parsed.is_off_cycle
    );
    if (existing) {
      return {
        error: [
          409,
          'An open payroll run already exists for this schedule and period. Delete the draft run first or continue with the existing one.',
          { existing_run_id: Number(existing.id), status: existing.status },
        ],
      };
    }
  }

  const candidates = await fetchCandidateEmployees(
    client,
    companyId,
    parsed.payroll_schedule_id,
    parsed.filters
  );

  const companySettings = await fetchCompanyPayrollSettings(client, companyId);
  const periodKeys = periodDateKeysFromSchedule(parsed.period_month, schedule);
  const holidayDateKeys =
    periodKeys.length > 0
      ? await getCompanyHolidayDateKeysForRange(
          companyId,
          periodKeys[0],
          periodKeys[periodKeys.length - 1],
          client
        )
      : new Set();

  const processed = [];
  const skipped = [];

  for (const employee of candidates) {
    const result = await buildEmployeeCalculation(
      client,
      companyId,
      employee,
      schedule,
      parsed.period_month,
      parsed.is_off_cycle,
      companySettings,
      holidayDateKeys
    );
    if (result.skipped) {
      skipped.push(result.skipped);
      continue;
    }
    processed.push(result);
  }

  if (!persist) {
    return {
      processed_count: processed.length,
      skipped_count: skipped.length,
      processed: processed.map((item) => ({
        employee_id: item.employee_id,
        employee_name: item.employee_name,
        ...item.calculated,
      })),
      skipped,
      payroll_schedule_id: parsed.payroll_schedule_id,
      period_month: parsed.period_month,
      is_off_cycle: parsed.is_off_cycle,
    };
  }

  if (processed.length === 0) {
    const selectedCount = parsed.filters?.employee_ids?.length || 0;
    return {
      error: [
        400,
        selectedCount > 0
          ? 'None of the selected employees could be processed. Fix skipped issues and try again.'
          : 'No employees could be processed. Fix skipped issues and try again.',
        { skipped },
      ],
    };
  }

  const skippedJson = JSON.stringify(skipped);
  const runResult = await client.query(
    `INSERT INTO payroll_runs (
       company_id, payroll_schedule_id, is_off_cycle, period_month, pay_date,
       status, skipped_employees, created_by
     ) VALUES ($1, $2, $3, $4, $5, 'draft', $6::jsonb, $7)
     RETURNING ${RUN_RETURNING_COLUMNS}`,
    [
      companyId,
      parsed.payroll_schedule_id,
      parsed.is_off_cycle,
      parsed.period_month,
      parsed.pay_date,
      skippedJson,
      createdBy,
    ]
  );

  const run = runResult.rows[0];
  const runId = Number(run.id);

  for (const item of processed) {
    await insertRunEmployee(client, runId, item.employee_id, item.calculated);
  }

  const totals = await computeRunTotals(client, runId);
  await client.query(
    `UPDATE payroll_runs
     SET total_gross = $1, total_deductions = $2, total_net = $3,
         updated_at = (NOW() AT TIME ZONE 'UTC')
     WHERE id = $4`,
    [totals.total_gross, totals.total_deductions, totals.total_net, runId]
  );

  const countResult = await client.query(
    `SELECT COUNT(*)::int AS count FROM payroll_run_employees WHERE payroll_run_id = $1`,
    [runId]
  );

  return {
    id: runId,
    run_id: runId,
    status: 'draft',
    processed_count: processed.length,
    skipped_count: skipped.length,
    totals,
    skipped,
    schedule_name: schedule.name,
    employee_count: countResult.rows[0].count,
  };
}

async function preview(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const parsed = parseRunBody(body);
  if (parsed.error) return parsed;

  const client = await pool.connect();
  try {
    return await runCalculation(client, Number(auth.admin.company_id), parsed, { persist: false });
  } finally {
    client.release();
  }
}

async function create(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const parsed = parseRunBody(body);
  if (parsed.error) return parsed;

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await runCalculation(client, companyId, parsed, {
      persist: true,
      createdBy: Number(auth.admin.id),
    });
    if (result.error) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function list(authUser, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const companyId = Number(auth.admin.company_id);
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const conditions = ['pr.company_id = $1'];
  const params = [companyId];

  if (query.status) {
    const status = String(query.status).trim().toLowerCase();
    if (!VALID_STATUSES.has(status)) {
      return { error: [400, 'Invalid status filter.'] };
    }
    params.push(status);
    conditions.push(`pr.status = $${params.length}`);
  }
  if (query.period_month) {
    const periodMonth = parsePeriodMonth(query.period_month);
    if (!periodMonth) return { error: [400, 'period_month must be YYYY-MM.'] };
    params.push(periodMonth);
    conditions.push(`pr.period_month = $${params.length}`);
  }
  if (query.payroll_schedule_id) {
    const scheduleId = parsePositiveInt(query.payroll_schedule_id);
    if (!scheduleId) return { error: [400, 'payroll_schedule_id must be a positive integer.'] };
    params.push(scheduleId);
    conditions.push(`pr.payroll_schedule_id = $${params.length}`);
  }
  if (query.is_off_cycle !== undefined && query.is_off_cycle !== '') {
    const isOffCycle = query.is_off_cycle === true || query.is_off_cycle === 'true';
    params.push(isOffCycle);
    conditions.push(`pr.is_off_cycle = $${params.length}`);
  }

  const searchTerm = String(query.search || query.schedule_name || '').trim();
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    conditions.push(`ps.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const fromSql = `FROM payroll_runs pr
     LEFT JOIN payroll_schedules ps ON ps.id = pr.payroll_schedule_id`;
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${fromSql} WHERE ${where}`,
    params
  );
  const total = countResult.rows[0].total;

  let sql = `SELECT ${RUN_COLUMNS}, ps.name AS schedule_name,
            (SELECT COUNT(*)::int FROM payroll_run_employees pre WHERE pre.payroll_run_id = pr.id) AS employee_count
     ${fromSql}
     WHERE ${where}
     ORDER BY pr.created_at DESC`;

  const listParams = [...params];
  if (!listPagination.noPagination) {
    const { limit, offset } = listPagination.pagination;
    listParams.push(limit, offset);
    sql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const result = await pool.query(sql, listParams);

  if (listPagination.noPagination) {
    return { items: result.rows.map((row) => mapRunRow(row)), total, pagination: null };
  }

  return {
    items: result.rows.map((row) => mapRunRow(row)),
    pagination: buildListPaginationMeta(total, listPagination),
  };
}

async function fetchPayableSalaryExpenseSummary(client, companyId, periodMonth) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS claim_count,
            COALESCE(SUM(erd.total_amount), 0)::numeric AS total_amount
     FROM requests r
     JOIN expense_request_details erd ON erd.request_id = r.id
     WHERE r.company_id = $1
       AND r.request_type = 'expense'
       AND r.status = 'approved'
       AND erd.paid_in = 'salary'
       AND erd.reimbursement_status = 'payable'
       AND (
         erd.reimbursement_month = $2
         OR (
           erd.reimbursement_month IS NULL
           AND TO_CHAR(
             COALESCE(erd.reimbursement_date, erd.payable_at)::date,
             'YYYY-MM'
           ) = $2
         )
       )`,
    [companyId, periodMonth]
  );
  const row = result.rows[0] || {};
  return {
    claim_count: Number(row.claim_count) || 0,
    total_amount: parseFloat(row.total_amount) || 0,
  };
}

async function fetchIncludedRunExpenseTotal(client, runId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(prl.amount), 0)::numeric AS total_amount,
            COUNT(*)::int AS line_count
     FROM payroll_run_lines prl
     JOIN payroll_run_employees pre ON pre.id = prl.payroll_run_employee_id
     WHERE pre.payroll_run_id = $1
       AND prl.line_kind = 'expense'`,
    [runId]
  );
  const row = result.rows[0] || {};
  return {
    line_count: Number(row.line_count) || 0,
    total_amount: parseFloat(row.total_amount) || 0,
  };
}

async function getById(authUser, runIdRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const result = await pool.query(
    `SELECT ${RUN_COLUMNS}, ps.name AS schedule_name,
            (SELECT COUNT(*)::int FROM payroll_run_employees pre WHERE pre.payroll_run_id = pr.id) AS employee_count
     FROM payroll_runs pr
     LEFT JOIN payroll_schedules ps ON ps.id = pr.payroll_schedule_id
     WHERE pr.id = $1 AND pr.company_id = $2`,
    [runId, companyId]
  );

  if (result.rowCount === 0) return { error: [404, 'Payroll run not found.'] };

  const run = mapRunRow(result.rows[0]);
  const payableExpenses = await fetchPayableSalaryExpenseSummary(
    pool,
    companyId,
    run.period_month
  );
  const includedExpenses = await fetchIncludedRunExpenseTotal(pool, runId);

  return {
    ...run,
    payable_salary_expenses: payableExpenses,
    included_expense_lines: includedExpenses,
    missing_salary_expenses:
      payableExpenses.claim_count > 0 &&
      includedExpenses.total_amount < payableExpenses.total_amount - 0.009,
  };
}

async function getSkipped(authUser, runIdRaw) {
  const run = await getById(authUser, runIdRaw);
  if (run.error) return run;
  return { items: run.skipped_employees || [], count: run.skipped_count || 0 };
}

async function listEmployees(authUser, runIdRaw, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const runCheck = await pool.query(
    `SELECT id FROM payroll_runs WHERE id = $1 AND company_id = $2`,
    [runId, companyId]
  );
  if (runCheck.rowCount === 0) return { error: [404, 'Payroll run not found.'] };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const conditions = ['pre.payroll_run_id = $1', 'e.company_id = $2'];
  const params = [runId, companyId];

  if (query.search) {
    const searchTerm = String(query.search).trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      const searchIndex = params.length;
      conditions.push(`(
        e.first_name ILIKE $${searchIndex}
        OR e.last_name ILIKE $${searchIndex}
        OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex}
        OR e.work_email ILIKE $${searchIndex}
        OR e.personal_email ILIKE $${searchIndex}
      )`);
    }
  }

  const where = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     WHERE ${where}`,
    params
  );
  const total = countResult.rows[0].total;

  let sql = `SELECT ${EMPLOYEE_COLUMNS}, e.first_name, e.last_name,
       COALESCE((
         SELECT SUM(prl.amount)::numeric
         FROM payroll_run_lines prl
         WHERE prl.payroll_run_employee_id = pre.id
           AND prl.line_kind = 'expense'
       ), 0) AS total_expenses
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     WHERE ${where}
     ORDER BY e.first_name ASC, e.last_name ASC`;

  const listParams = [...params];
  if (!listPagination.noPagination) {
    const { limit, offset } = listPagination.pagination;
    listParams.push(limit, offset);
    sql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const result = await pool.query(sql, listParams);

  if (listPagination.noPagination) {
    return { items: result.rows.map(mapEmployeeRow), total, pagination: null };
  }

  return {
    items: result.rows.map(mapEmployeeRow),
    pagination: buildListPaginationMeta(total, listPagination),
  };
}

async function getEmployee(authUser, runIdRaw, employeeIdRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  const employeeId = parsePositiveInt(employeeIdRaw);
  if (!runId || !employeeId) {
    return { error: [400, 'Run id and employee id must be positive integers.'] };
  }

  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, e.first_name, e.last_name,
            COALESCE((
              SELECT SUM(prl.amount)::numeric
              FROM payroll_run_lines prl
              WHERE prl.payroll_run_employee_id = pre.id
                AND prl.line_kind = 'expense'
            ), 0) AS total_expenses
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     WHERE pre.payroll_run_id = $1 AND pre.employee_id = $2 AND pr.company_id = $3`,
    [runId, employeeId, Number(auth.admin.company_id)]
  );

  if (result.rowCount === 0) return { error: [404, 'Employee not found in this payroll run.'] };

  const row = result.rows[0];
  const linesResult = await pool.query(
    `SELECT id, line_kind, label, amount, source_ref
     FROM payroll_run_lines
     WHERE payroll_run_employee_id = $1
     ORDER BY id ASC`,
    [Number(row.id)]
  );

  return {
    ...mapEmployeeRow(row),
    lines: linesResult.rows.map(mapLineRow),
  };
}

async function recalcRunEmployee(client, runEmployeeId) {
  const linesResult = await client.query(
    `SELECT line_kind, label, amount, source_ref
     FROM payroll_run_lines
     WHERE payroll_run_employee_id = $1
     ORDER BY id ASC`,
    [runEmployeeId]
  );

  const lines = linesResult.rows.map((row) => ({
    line_kind: row.line_kind,
    label: row.label,
    amount: parseFloat(row.amount),
    source_ref: row.source_ref,
  }));

  const totals = totalsFromLines(lines);
  const presentResult = await client.query(
    `SELECT present_days, absent_days FROM payroll_run_employees WHERE id = $1`,
    [runEmployeeId]
  );
  const presentDays = parseFloat(presentResult.rows[0]?.present_days) || 0;
  const absentDays = parseFloat(presentResult.rows[0]?.absent_days) || 0;

  await client.query(
    `UPDATE payroll_run_employees
     SET basic_salary = $1, total_allowances = $2, total_deductions = $3,
         total_contributions = $4, gross_pay = $5, net_pay = $6
     WHERE id = $7`,
    [
      totals.basic_salary,
      totals.total_allowances,
      totals.total_deductions,
      totals.total_contributions,
      totals.gross_pay,
      totals.net_pay,
      runEmployeeId,
    ]
  );

  return { ...totals, present_days: presentDays, absent_days: absentDays, lines };
}

async function updateEmployee(authUser, runIdRaw, employeeIdRaw, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  const employeeId = parsePositiveInt(employeeIdRaw);
  if (!runId || !employeeId) {
    return { error: [400, 'Run id and employee id must be positive integers.'] };
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { error: [400, 'lines must be a non-empty array.'] };
  }

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const runResult = await client.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [runId, companyId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }
    if (runResult.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return { error: [400, 'Only draft payroll runs can be edited.'] };
    }

    const empResult = await client.query(
      `SELECT id FROM payroll_run_employees
       WHERE payroll_run_id = $1 AND employee_id = $2 FOR UPDATE`,
      [runId, employeeId]
    );
    if (empResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Employee not found in this payroll run.'] };
    }

    const runEmployeeId = Number(empResult.rows[0].id);
    await client.query(`DELETE FROM payroll_run_lines WHERE payroll_run_employee_id = $1`, [runEmployeeId]);

    for (const line of body.lines) {
      const kind = String(line.line_kind || '').trim();
      const label = String(line.label || '').trim();
      const amount = roundMoney(line.amount);
      if (!kind || !label) {
        await client.query('ROLLBACK');
        return { error: [400, 'Each line needs line_kind and label.'] };
      }
      await client.query(
        `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
         VALUES ($1, $2, $3, $4, $5)`,
        [runEmployeeId, kind, label, amount, line.source_ref || 'manual_override']
      );
    }

    const updated = await recalcRunEmployee(client, runEmployeeId);
    const totals = await computeRunTotals(client, runId);
    await client.query(
      `UPDATE payroll_runs
       SET total_gross = $1, total_deductions = $2, total_net = $3,
           updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE id = $4`,
      [totals.total_gross, totals.total_deductions, totals.total_net, runId]
    );

    await client.query('COMMIT');
    return {
      employee_id: employeeId,
      ...updated,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function bulkUpdate(authUser, runIdRaw, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const change = body.change && typeof body.change === 'object' ? body.change : null;
  if (!change) return { error: [400, 'change object is required.'] };

  const action = String(change.action || '').trim().toLowerCase();
  const lineKind = String(change.line_kind || '').trim();
  const label = String(change.label || '').trim();
  if (!['remove', 'upsert'].includes(action)) {
    return { error: [400, 'change.action must be remove or upsert.'] };
  }
  if (!lineKind || !label) {
    return { error: [400, 'change.line_kind and change.label are required.'] };
  }
  if (action === 'upsert' && change.amount == null) {
    return { error: [400, 'change.amount is required for upsert.'] };
  }

  const filtersParsed = parseFilters({ filters: body.filters || {} });
  if (filtersParsed.error) return filtersParsed;
  const filters = filtersParsed.filters;

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const runResult = await client.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [runId, companyId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }
    if (runResult.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return { error: [400, 'Bulk update is only allowed on draft runs.'] };
    }

    const params = [runId, companyId];
    const conditions = ['pre.payroll_run_id = $1', 'e.company_id = $2'];
    if (filters.department_id) {
      params.push(filters.department_id);
      conditions.push(`ejd.department_id = $${params.length}`);
    }
    if (filters.work_location_id) {
      params.push(filters.work_location_id);
      conditions.push(`ejd.work_location_id = $${params.length}`);
    }
    if (filters.employee_ids?.length) {
      params.push(filters.employee_ids);
      conditions.push(`pre.employee_id = ANY($${params.length}::bigint[])`);
    }

    const employees = await client.query(
      `SELECT pre.id, pre.employee_id
       FROM payroll_run_employees pre
       JOIN employees e ON e.id = pre.employee_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    let updatedCount = 0;
    for (const row of employees.rows) {
      const runEmployeeId = Number(row.id);
      if (action === 'remove') {
        await client.query(
          `DELETE FROM payroll_run_lines
           WHERE payroll_run_employee_id = $1 AND line_kind = $2 AND label = $3`,
          [runEmployeeId, lineKind, label]
        );
      } else {
        const amount = roundMoney(change.amount);
        const existing = await client.query(
          `SELECT id FROM payroll_run_lines
           WHERE payroll_run_employee_id = $1 AND line_kind = $2 AND label = $3`,
          [runEmployeeId, lineKind, label]
        );
        if (existing.rowCount > 0) {
          await client.query(
            `UPDATE payroll_run_lines SET amount = $1, source_ref = 'manual_override'
             WHERE id = $2`,
            [amount, existing.rows[0].id]
          );
        } else {
          await client.query(
            `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
             VALUES ($1, $2, $3, $4, 'manual_override')`,
            [runEmployeeId, lineKind, label, amount]
          );
        }
      }
      await recalcRunEmployee(client, runEmployeeId);
      updatedCount += 1;
    }

    const totals = await computeRunTotals(client, runId);
    await client.query(
      `UPDATE payroll_runs
       SET total_gross = $1, total_deductions = $2, total_net = $3,
           updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE id = $4`,
      [totals.total_gross, totals.total_deductions, totals.total_net, runId]
    );

    await client.query('COMMIT');
    return { updated_count: updatedCount, totals };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function parseNumericField(value, fieldName, rowIndex, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) {
      return { error: [400, `Row ${rowIndex}: ${fieldName} is required.`] };
    }
    return { value: null };
  }
  const numeric = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(numeric)) {
    return { error: [400, `Row ${rowIndex}: ${fieldName} must be a valid number.`] };
  }
  return { value: roundMoney(numeric) };
}

function parseImportRow(row, rowIndex) {
  const employeeId = parsePositiveInt(row?.employee_id);
  const employeeCode = String(row?.employee_code ?? '').trim();
  if (!employeeId && !employeeCode) {
    return { error: [400, `Row ${rowIndex}: employee_id or employee_code is required.`] };
  }

  // Legacy line-level import support (Employee ID + Line Kind + Label + Amount).
  if (row?.line_kind != null || row?.label != null || row?.action != null) {
    const lineKind = String(row?.line_kind ?? '').trim();
    if (!VALID_LINE_KINDS.has(lineKind)) {
      return { error: [400, `Row ${rowIndex}: invalid line_kind.`] };
    }

    const label = String(row?.label ?? '').trim();
    if (!label) {
      return { error: [400, `Row ${rowIndex}: label is required.`] };
    }
    if (label.length > 120) {
      return { error: [400, `Row ${rowIndex}: label must be 120 characters or fewer.`] };
    }

    const action = String(row?.action ?? 'upsert').trim().toLowerCase();
    if (!['remove', 'upsert'].includes(action)) {
      return { error: [400, `Row ${rowIndex}: action must be remove or upsert.`] };
    }

    const numericAmount = Number(row?.amount);
    if (
      action === 'upsert' &&
      (row?.amount == null || row?.amount === '' || !Number.isFinite(numericAmount))
    ) {
      return { error: [400, `Row ${rowIndex}: amount must be a valid number for upsert.`] };
    }

    return {
      format: 'line',
      employee_id: employeeId || null,
      employee_code: employeeCode || null,
      line_kind: lineKind,
      label,
      action,
      amount: action === 'upsert' ? roundMoney(numericAmount) : null,
    };
  }

  const basic = parseNumericField(row?.basic_salary ?? row?.basic, 'Basic', rowIndex);
  if (basic.error) return basic;
  const allowances = parseNumericField(
    row?.total_allowances ?? row?.allowances,
    'Allowances',
    rowIndex
  );
  if (allowances.error) return allowances;
  const deductions = parseNumericField(
    row?.total_deductions ?? row?.deductions,
    'Deductions',
    rowIndex
  );
  if (deductions.error) return deductions;
  const contributions = parseNumericField(
    row?.total_contributions ?? row?.contributions,
    'Contributions',
    rowIndex
  );
  if (contributions.error) return contributions;
  const presentDays = parseNumericField(
    row?.present_days,
    'Present Days',
    rowIndex
  );
  if (presentDays.error) return presentDays;
  if (presentDays.value < 0 || presentDays.value > 366) {
    return { error: [400, `Row ${rowIndex}: Present Days must be between 0 and 366.`] };
  }
  const absentDays = parseNumericField(row?.absent_days, 'Absent Days', rowIndex);
  if (absentDays.error) return absentDays;
  if (absentDays.value < 0 || absentDays.value > 366) {
    return { error: [400, `Row ${rowIndex}: Absent Days must be between 0 and 366.`] };
  }
  for (const [fieldName, value] of [
    ['Basic', basic.value],
    ['Allowances', allowances.value],
    ['Deductions', deductions.value],
    ['Contributions', contributions.value],
  ]) {
    if (Math.abs(value) > 999999999999.99) {
      return { error: [400, `Row ${rowIndex}: ${fieldName} is too large.`] };
    }
  }

  return {
    format: 'employee',
    employee_id: employeeId || null,
    employee_code: employeeCode || null,
    basic_salary: basic.value,
    total_allowances: allowances.value,
    total_deductions: deductions.value,
    total_contributions: contributions.value,
    present_days: presentDays.value,
    absent_days: absentDays.value,
  };
}

async function applyLineChange(client, runEmployeeId, { action, line_kind, label, amount }) {
  if (action === 'remove') {
    await client.query(
      `DELETE FROM payroll_run_lines
       WHERE payroll_run_employee_id = $1 AND line_kind = $2 AND label = $3`,
      [runEmployeeId, line_kind, label]
    );
  } else {
    const existing = await client.query(
      `SELECT id FROM payroll_run_lines
       WHERE payroll_run_employee_id = $1 AND line_kind = $2 AND label = $3`,
      [runEmployeeId, line_kind, label]
    );
    if (existing.rowCount > 0) {
      await client.query(
        `UPDATE payroll_run_lines SET amount = $1
         WHERE id = $2`,
        [amount, existing.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
         VALUES ($1, $2, $3, $4, 'import')`,
        [runEmployeeId, line_kind, label, amount]
      );
    }
  }
  await recalcRunEmployee(client, runEmployeeId);
}

async function syncKindTotal(client, runEmployeeId, lineKind, targetAmount, defaultLabel) {
  const existing = await client.query(
    `SELECT id, label, amount
     FROM payroll_run_lines
     WHERE payroll_run_employee_id = $1 AND line_kind = $2
     ORDER BY id ASC`,
    [runEmployeeId, lineKind]
  );

  const amount = roundMoney(targetAmount);
  if (existing.rowCount === 0) {
    if (amount === 0 && lineKind !== 'basic') return;
    await client.query(
      `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
       VALUES ($1, $2, $3, $4, 'import')`,
      [runEmployeeId, lineKind, defaultLabel, amount]
    );
    return;
  }

  await client.query(
    `UPDATE payroll_run_lines SET amount = $1 WHERE id = $2`,
    [amount, existing.rows[0].id]
  );

  if (existing.rowCount > 1) {
    const extraIds = existing.rows.slice(1).map((row) => Number(row.id));
    await client.query(`DELETE FROM payroll_run_lines WHERE id = ANY($1::int[])`, [extraIds]);
  }
}

async function applyEmployeeImportRow(client, runEmployeeId, row) {
  if (row.present_days < 0 || row.present_days > 366 || row.absent_days < 0 || row.absent_days > 366) {
    return {
      error: [400, 'Present Days and Absent Days must be between 0 and 366.'],
    };
  }

  await client.query(
    `UPDATE payroll_run_employees
     SET present_days = $1, absent_days = $2
     WHERE id = $3`,
    [row.present_days, row.absent_days, runEmployeeId]
  );

  const linesResult = await client.query(
    `SELECT line_kind, amount
     FROM payroll_run_lines
     WHERE payroll_run_employee_id = $1`,
    [runEmployeeId]
  );

  let lockedAllowances = 0;
  let lockedDeductions = 0;
  for (const line of linesResult.rows) {
    const amount = parseFloat(line.amount) || 0;
    if (line.line_kind === 'monthly_input' || line.line_kind === 'expense') {
      lockedAllowances += amount;
    } else if (line.line_kind === 'loan' || line.line_kind === 'absence') {
      lockedDeductions += amount;
    }
  }

  const allowanceTarget = roundMoney(row.total_allowances - lockedAllowances);
  const deductionTarget = roundMoney(row.total_deductions - lockedDeductions);
  if (allowanceTarget < 0) {
    return {
      error: [
        400,
        `Allowances (${row.total_allowances}) cannot be less than locked monthly input/expense total (${roundMoney(lockedAllowances)}).`,
      ],
    };
  }
  if (deductionTarget < 0) {
    return {
      error: [
        400,
        `Deductions (${row.total_deductions}) cannot be less than locked loan/absence total (${roundMoney(lockedDeductions)}).`,
      ],
    };
  }

  await syncKindTotal(client, runEmployeeId, 'basic', row.basic_salary, 'Basic');
  await syncKindTotal(client, runEmployeeId, 'allowance', allowanceTarget, 'Allowances');
  await syncKindTotal(client, runEmployeeId, 'deduction', deductionTarget, 'Deductions');
  await syncKindTotal(
    client,
    runEmployeeId,
    'contribution',
    row.total_contributions,
    'Contributions'
  );
  return recalcRunEmployee(client, runEmployeeId);
}

async function buildImportTemplate(authUser, runIdRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const runResult = await pool.query(
    `SELECT id, period_month, pay_date, is_off_cycle, status
     FROM payroll_runs
     WHERE id = $1 AND company_id = $2`,
    [runId, companyId]
  );
  if (runResult.rowCount === 0) {
    return { error: [404, 'Payroll run not found.'] };
  }
  const run = runResult.rows[0];
  if (run.status !== 'draft') {
    return { error: [400, 'Salary import template is only available for draft runs.'] };
  }

  const result = await pool.query(
    `SELECT pre.basic_salary, pre.present_days, pre.absent_days,
            pre.total_allowances, pre.total_deductions, pre.total_contributions,
            pre.gross_pay, pre.net_pay,
            e.employee_code, e.first_name, e.last_name
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     WHERE pre.payroll_run_id = $1 AND e.company_id = $2
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [runId, companyId]
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payroll');
  sheet.columns = [
    { header: 'Employee Code', key: 'employee_code', width: 18 },
    { header: 'Employee Name', key: 'employee_name', width: 28 },
    { header: 'Period', key: 'period_month', width: 12 },
    { header: 'Pay Date', key: 'pay_date', width: 14 },
    { header: 'Off Cycle', key: 'is_off_cycle', width: 12 },
    { header: 'Present Days', key: 'present_days', width: 14 },
    { header: 'Absent Days', key: 'absent_days', width: 14 },
    { header: 'Basic', key: 'basic_salary', width: 14 },
    { header: 'Allowances', key: 'total_allowances', width: 14 },
    { header: 'Deductions', key: 'total_deductions', width: 14 },
    { header: 'Contributions', key: 'total_contributions', width: 14 },
    { header: 'Gross Pay', key: 'gross_pay', width: 14 },
    { header: 'Net Pay', key: 'net_pay', width: 14 },
  ];
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of result.rows) {
    sheet.addRow({
      employee_code: row.employee_code || '',
      employee_name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      period_month: String(run.period_month || ''),
      pay_date: toDateKey(run.pay_date) || '',
      is_off_cycle: run.is_off_cycle ? 'Yes' : 'No',
      present_days: row.present_days == null ? '' : parseFloat(row.present_days),
      absent_days: row.absent_days == null ? '' : parseFloat(row.absent_days),
      basic_salary: parseFloat(row.basic_salary) || 0,
      total_allowances: parseFloat(row.total_allowances) || 0,
      total_deductions: parseFloat(row.total_deductions) || 0,
      total_contributions: parseFloat(row.total_contributions) || 0,
      gross_pay: parseFloat(row.gross_pay) || 0,
      net_pay: parseFloat(row.net_pay) || 0,
    });
  }

  sheet.getRow(1).font = { bold: true };
  for (const key of [
    'basic_salary',
    'total_allowances',
    'total_deductions',
    'total_contributions',
    'gross_pay',
    'net_pay',
  ]) {
    sheet.getColumn(key).numFmt = '#,##0.00';
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const period = String(run.period_month || 'period').replace(/-/g, '');
  return {
    buffer: Buffer.from(buffer),
    filename: `payroll-run-${runId}-${period}-salary-import.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

async function validateImportRows(authUser, runIdRaw, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) {
    return { error: [400, 'rows must be a non-empty array.'] };
  }
  if (rows.length > 5000) {
    return { error: [400, 'A maximum of 5000 import rows is allowed.'] };
  }

  const companyId = Number(auth.admin.company_id);
  const runResult = await pool.query(
    `SELECT id, status FROM payroll_runs WHERE id = $1 AND company_id = $2`,
    [runId, companyId]
  );
  if (runResult.rowCount === 0) {
    return { error: [404, 'Payroll run not found.'] };
  }
  if (runResult.rows[0].status !== 'draft') {
    return { error: [400, 'Import is only allowed on draft runs.'] };
  }

  const errors = [];
  const parsedRows = [];
  for (let i = 0; i < rows.length; i += 1) {
    const displayRow = parsePositiveInt(rows[i]?.row_number) || i + 2;
    const parsed = parseImportRow(rows[i], displayRow);
    if (parsed.error) {
      errors.push({ row_number: displayRow, message: parsed.error[1] });
      continue;
    }
    parsedRows.push({ ...parsed, row_number: displayRow });
  }

  const runEmployeesResult = await pool.query(
    `SELECT pre.employee_id, pre.present_days, pre.absent_days, pre.status,
            e.employee_code, e.first_name, e.last_name
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     WHERE pre.payroll_run_id = $1 AND e.company_id = $2`,
    [runId, companyId]
  );
  const employeesById = new Map(
    runEmployeesResult.rows.map((row) => [Number(row.employee_id), row])
  );
  const employeesByCode = new Map(
    runEmployeesResult.rows
      .filter((row) => row.employee_code)
      .map((row) => [String(row.employee_code).trim().toLowerCase(), row])
  );

  const seenEmployees = new Set();
  const seenLineKeys = new Set();
  const validRows = [];
  const employees = [];

  for (const row of parsedRows) {
    const employee = row.employee_id
      ? employeesById.get(row.employee_id)
      : employeesByCode.get(String(row.employee_code).toLowerCase());
    if (!employee) {
      errors.push({
        row_number: row.row_number,
        message: `Row ${row.row_number}: employee is not part of this payroll run.`,
      });
      continue;
    }

    const employeeId = Number(employee.employee_id);
    const employeeName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
    const employeeCode = employee.employee_code || '';

    if (row.format === 'employee') {
      if (seenEmployees.has(employeeId)) {
        errors.push({
          row_number: row.row_number,
          message: `Row ${row.row_number}: duplicate employee in the import file.`,
        });
        continue;
      }
      seenEmployees.add(employeeId);

      const grossPay = roundMoney(row.basic_salary + row.total_allowances);
      const netPay = roundMoney(
        grossPay - row.total_deductions - row.total_contributions
      );

      const validRow = {
        ...row,
        employee_id: employeeId,
        employee_code: employeeCode,
        employee_name: employeeName,
      };
      validRows.push(validRow);
      employees.push({
        row_number: row.row_number,
        employee_id: employeeId,
        employee_code: employeeCode,
        employee_name: employeeName,
        present_days: row.present_days,
        absent_days: row.absent_days,
        basic_salary: row.basic_salary,
        total_allowances: row.total_allowances,
        total_deductions: row.total_deductions,
        total_contributions: row.total_contributions,
        gross_pay: grossPay,
        net_pay: netPay,
        status: employee.status,
      });
      continue;
    }

    const duplicateKey = `${employeeId}:${row.line_kind}:${row.label.toLowerCase()}`;
    if (seenLineKeys.has(duplicateKey)) {
      errors.push({
        row_number: row.row_number,
        message: `Row ${row.row_number}: duplicate employee, line kind, and label.`,
      });
      continue;
    }
    seenLineKeys.add(duplicateKey);
    validRows.push({
      ...row,
      employee_id: employeeId,
      employee_code: employeeCode,
      employee_name: employeeName,
    });
  }

  // Legacy line-level preview projection for older payloads.
  if (employees.length === 0 && validRows.some((row) => row.format === 'line')) {
    const affectedEmployeeIds = [...new Set(validRows.map((row) => row.employee_id))];
    const linesResult = affectedEmployeeIds.length
      ? await pool.query(
          `SELECT pre.employee_id, prl.line_kind, prl.label, prl.amount
           FROM payroll_run_lines prl
           JOIN payroll_run_employees pre ON pre.id = prl.payroll_run_employee_id
           WHERE pre.payroll_run_id = $1
             AND pre.employee_id = ANY($2::int[])`,
          [runId, affectedEmployeeIds]
        )
      : { rows: [] };
    const linesByEmployee = new Map(
      affectedEmployeeIds.map((employeeId) => [employeeId, []])
    );
    for (const line of linesResult.rows) {
      linesByEmployee.get(Number(line.employee_id))?.push({
        line_kind: line.line_kind,
        label: line.label,
        amount: parseFloat(line.amount),
      });
    }

    const rowNumbersByEmployee = new Map();
    for (const row of validRows) {
      if (!rowNumbersByEmployee.has(row.employee_id)) {
        rowNumbersByEmployee.set(row.employee_id, row.row_number);
      }
      const lines = linesByEmployee.get(row.employee_id) || [];
      const existingIndex = lines.findIndex(
        (line) => line.line_kind === row.line_kind && line.label === row.label
      );
      if (row.action === 'remove') {
        if (existingIndex >= 0) lines.splice(existingIndex, 1);
      } else if (existingIndex >= 0) {
        lines[existingIndex] = { ...lines[existingIndex], amount: row.amount };
      } else {
        lines.push({
          line_kind: row.line_kind,
          label: row.label,
          amount: row.amount,
        });
      }
      linesByEmployee.set(row.employee_id, lines);
    }

    for (const employeeId of affectedEmployeeIds) {
      const employee = employeesById.get(employeeId);
      employees.push({
        row_number: rowNumbersByEmployee.get(employeeId),
        employee_id: employeeId,
        employee_code: employee.employee_code || '',
        employee_name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
        present_days: parseFloat(employee.present_days),
        absent_days: parseFloat(employee.absent_days),
        status: employee.status,
        ...totalsFromLines(linesByEmployee.get(employeeId) || []),
      });
    }
  }

  errors.sort((a, b) => a.row_number - b.row_number);
  return {
    valid: errors.length === 0,
    total_count: rows.length,
    valid_count: validRows.length,
    error_count: errors.length,
    rows: validRows,
    employees,
    errors,
  };
}

async function importRows(authUser, runIdRaw, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const validation = await validateImportRows(authUser, runId, body);
  if (validation.error) return validation;
  if (!validation.valid) {
    return {
      error: [400, 'Import validation failed. Fix the invalid rows and validate again.', validation],
    };
  }
  const parsedRows = validation.rows;

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const runResult = await client.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [runId, companyId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }
    if (runResult.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return { error: [400, 'Import is only allowed on draft runs.'] };
    }

    const updatedEmployeeIds = new Set();
    let appliedCount = 0;

    for (let i = 0; i < parsedRows.length; i += 1) {
      const row = parsedRows[i];
      const empResult = await client.query(
        `SELECT pre.id
         FROM payroll_run_employees pre
         JOIN employees e ON e.id = pre.employee_id
         WHERE pre.payroll_run_id = $1 AND pre.employee_id = $2 AND e.company_id = $3`,
        [runId, row.employee_id, companyId]
      );

      if (empResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          error: [
            400,
            `Row ${row.row_number || i + 2}: employee is no longer part of this payroll run.`,
          ],
        };
      }

      const runEmployeeId = Number(empResult.rows[0].id);
      if (row.format === 'employee') {
        const applied = await applyEmployeeImportRow(client, runEmployeeId, row);
        if (applied?.error) {
          await client.query('ROLLBACK');
          return applied;
        }
      } else {
        await applyLineChange(client, runEmployeeId, row);
      }
      updatedEmployeeIds.add(row.employee_id);
      appliedCount += 1;
    }

    const totals = await computeRunTotals(client, runId);
    await client.query(
      `UPDATE payroll_runs
       SET total_gross = $1, total_deductions = $2, total_net = $3,
           updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE id = $4`,
      [totals.total_gross, totals.total_deductions, totals.total_net, runId]
    );

    await client.query('COMMIT');
    return {
      applied_count: appliedCount,
      updated_employee_count: updatedEmployeeIds.size,
      failed_rows: [],
      totals,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err?.statusCode === 400) {
      return { error: [400, err.message] };
    }
    if (err?.code === '22003') {
      return {
        error: [
          400,
          'One or more numeric values are out of range. Check Present Days, Absent Days, and amount columns.',
        ],
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function applyCloseSideEffects(client, runId, companyId, closedBy, periodMonth) {
  const linesResult = await client.query(
    `SELECT prl.line_kind, prl.amount, prl.source_ref, pre.employee_id
     FROM payroll_run_lines prl
     JOIN payroll_run_employees pre ON pre.id = prl.payroll_run_employee_id
     WHERE pre.payroll_run_id = $1`,
    [runId]
  );

  const monthlyInputIds = new Set();
  const loanPayments = [];
  const expenseIds = new Set();

  for (const row of linesResult.rows) {
    const ref = String(row.source_ref || '');
    if (ref.startsWith('monthly_input:')) {
      monthlyInputIds.add(Number(ref.split(':')[1]));
    } else if (ref.startsWith('loan:')) {
      loanPayments.push({
        loan_id: Number(ref.split(':')[1]),
        amount: parseFloat(row.amount),
      });
    } else if (ref.startsWith('expense:')) {
      expenseIds.add(Number(ref.split(':')[1]));
    }
  }

  if (monthlyInputIds.size > 0) {
    await client.query(
      `UPDATE monthly_inputs
       SET consumed_by_run_id = $1, updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE company_id = $2 AND id = ANY($3::bigint[]) AND consumed_by_run_id IS NULL`,
      [runId, companyId, [...monthlyInputIds]]
    );
  }

  for (const payment of loanPayments) {
    const loanResult = await client.query(
      `SELECT id, outstanding_balance FROM loans
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [payment.loan_id, companyId]
    );
    if (loanResult.rowCount === 0) continue;

    const outstanding = parseFloat(loanResult.rows[0].outstanding_balance);
    const payAmount = Math.min(payment.amount, outstanding);
    if (payAmount <= 0) continue;

    await client.query(
      `INSERT INTO loan_payments (loan_id, amount, payment_date, notes, recorded_by, payment_source)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, 'payroll')`,
      [payment.loan_id, payAmount, `Payroll run #${runId}`, closedBy]
    );

    const newBalance = roundMoney(outstanding - payAmount);
    await client.query(
      `UPDATE loans
       SET outstanding_balance = $1,
           status = CASE WHEN $1 <= 0::numeric THEN 'closed' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [newBalance, payment.loan_id]
    );
  }

  if (expenseIds.size > 0) {
    await client.query(
      `UPDATE expense_request_details
       SET reimbursement_status = 'paid',
           paid_at = (NOW() AT TIME ZONE 'UTC'),
           payment_confirmed_by = $1
       WHERE request_id = ANY($2::bigint[])
         AND reimbursement_status = 'payable'`,
      [closedBy, [...expenseIds]]
    );
  }

  return pfBalanceService.processPayrollRunContributions(client, {
    runId,
    companyId,
    periodMonth,
    recordedBy: closedBy,
  });
}

async function transition(authUser, runIdRaw, actionRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const action = String(actionRaw ?? '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return { error: [400, 'action must be one of: post, approve, finalize, return, close.'] };
  }

  const rule = TRANSITIONS[action];
  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const runResult = await client.query(
      `SELECT id, status, period_month FROM payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [runId, companyId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }

    const currentStatus = runResult.rows[0].status;
    const periodMonth = runResult.rows[0].period_month;
    if (!rule.from.has(currentStatus)) {
      await client.query('ROLLBACK');
      return {
        error: [400, `Cannot move from ${currentStatus} via "${action}".`],
      };
    }

    const nextStatus = rule.to;
    let pfContributions = null;

    if (action === 'close') {
      pfContributions = await applyCloseSideEffects(
        client,
        runId,
        companyId,
        Number(auth.admin.id),
        periodMonth
      );
      await client.query(
        `UPDATE payroll_runs
         SET status = 'closed', closed_at = (NOW() AT TIME ZONE 'UTC'),
             updated_at = (NOW() AT TIME ZONE 'UTC')
         WHERE id = $1`,
        [runId]
      );
      await client.query(
        `UPDATE payroll_run_employees SET status = 'closed' WHERE payroll_run_id = $1`,
        [runId]
      );
    } else {
      await client.query(
        `UPDATE payroll_runs
         SET status = $1, updated_at = (NOW() AT TIME ZONE 'UTC')
         WHERE id = $2`,
        [nextStatus, runId]
      );
      await client.query(
        `UPDATE payroll_run_employees SET status = $1 WHERE payroll_run_id = $2`,
        [nextStatus, runId]
      );
    }

    const updated = await client.query(
      `SELECT ${RUN_COLUMNS}, ps.name AS schedule_name
       FROM payroll_runs pr
       LEFT JOIN payroll_schedules ps ON ps.id = pr.payroll_schedule_id
       WHERE pr.id = $1`,
      [runId]
    );

    await client.query('COMMIT');
    return {
      action,
      status: nextStatus,
      run: mapRunRow(updated.rows[0]),
      ...(pfContributions ? { pf_contributions: pfContributions } : {}),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const EXPORT_HEADERS = [
  'Employee Code',
  'Employee Name',
  'Period',
  'Pay Date',
  'Off Cycle',
  'Present Days',
  'Absent Days',
  'Basic',
  'Allowances',
  'Deductions',
  'Contributions',
  'Gross Pay',
  'Net Pay',
];

function mapExportRow(row, run) {
  return {
    employee_code: row.employee_code || '',
    employee_name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    period_month: String(run.period_month || ''),
    pay_date: toDateKey(run.pay_date) || '',
    is_off_cycle: run.is_off_cycle ? 'Yes' : 'No',
    present_days: parseFloat(row.present_days),
    absent_days: parseFloat(row.absent_days),
    basic_salary: parseFloat(row.basic_salary),
    total_allowances: parseFloat(row.total_allowances),
    total_deductions: parseFloat(row.total_deductions),
    total_contributions: parseFloat(row.total_contributions),
    gross_pay: parseFloat(row.gross_pay),
    net_pay: parseFloat(row.net_pay),
  };
}

function buildExportFilename(run, format) {
  const period = String(run.period_month || 'period').replace(/-/g, '');
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  return `payroll-run-${run.id}-${period}.${ext}`;
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvBuffer(rows) {
  const lines = [EXPORT_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvValue(row.employee_code),
        escapeCsvValue(row.employee_name),
        escapeCsvValue(row.period_month),
        escapeCsvValue(row.pay_date),
        escapeCsvValue(row.is_off_cycle),
        row.present_days,
        row.absent_days,
        row.basic_salary,
        row.total_allowances,
        row.total_deductions,
        row.total_contributions,
        row.gross_pay,
        row.net_pay,
      ].join(',')
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

async function buildXlsxBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payroll');

  sheet.columns = [
    { header: 'Employee Code', key: 'employee_code', width: 16 },
    { header: 'Employee Name', key: 'employee_name', width: 28 },
    { header: 'Period', key: 'period_month', width: 12 },
    { header: 'Pay Date', key: 'pay_date', width: 14 },
    { header: 'Off Cycle', key: 'is_off_cycle', width: 12 },
    { header: 'Present Days', key: 'present_days', width: 14 },
    { header: 'Absent Days', key: 'absent_days', width: 14 },
    { header: 'Basic', key: 'basic_salary', width: 14 },
    { header: 'Allowances', key: 'total_allowances', width: 14 },
    { header: 'Deductions', key: 'total_deductions', width: 14 },
    { header: 'Contributions', key: 'total_contributions', width: 14 },
    { header: 'Gross Pay', key: 'gross_pay', width: 14 },
    { header: 'Net Pay', key: 'net_pay', width: 14 },
  ];

  if (rows.length > 0) {
    sheet.addRows(rows);
  }

  sheet.getRow(1).font = { bold: true };
  for (const key of [
    'basic_salary',
    'total_allowances',
    'total_deductions',
    'total_contributions',
    'gross_pay',
    'net_pay',
  ]) {
    sheet.getColumn(key).numFmt = '#,##0.00';
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function exportSheet(authUser, runIdRaw, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const format = String(query.format || 'xlsx').trim().toLowerCase();
  if (!['xlsx', 'csv'].includes(format)) {
    return { error: [400, 'format must be xlsx or csv.'] };
  }

  const companyId = Number(auth.admin.company_id);
  const runResult = await pool.query(
    `SELECT id, period_month, pay_date, is_off_cycle, status
     FROM payroll_runs
     WHERE id = $1 AND company_id = $2`,
    [runId, companyId]
  );
  if (runResult.rowCount === 0) {
    return { error: [404, 'Payroll run not found.'] };
  }

  const run = runResult.rows[0];
  if (run.status !== 'closed') {
    return { error: [400, 'Payroll run must be closed before export.'] };
  }

  const employeesResult = await pool.query(
    `SELECT pre.basic_salary, pre.present_days, pre.absent_days,
            pre.total_allowances, pre.total_deductions,
            pre.total_contributions, pre.gross_pay, pre.net_pay,
            e.employee_code, e.first_name, e.last_name
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     WHERE pre.payroll_run_id = $1 AND e.company_id = $2
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [runId, companyId]
  );

  const rows = employeesResult.rows.map((row) => mapExportRow(row, run));
  const filename = buildExportFilename(run, format);

  if (format === 'csv') {
    return {
      buffer: buildCsvBuffer(rows),
      filename,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  return {
    buffer: await buildXlsxBuffer(rows),
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

async function remove(authUser, runIdRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, status FROM payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [runId, companyId]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }
    if (result.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return { error: [400, 'Only draft payroll runs can be deleted.'] };
    }

    await client.query(`DELETE FROM payroll_runs WHERE id = $1`, [runId]);
    await client.query('COMMIT');
    return { deleted_id: runId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rebuild a draft run from live sources (expenses, loans, attendance, etc.).
 * Use after approving salary-paid expenses so they appear before close.
 */
async function rebuildDraft(authUser, runIdRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT ${RUN_COLUMNS}
       FROM payroll_runs pr
       WHERE pr.id = $1 AND pr.company_id = $2
       FOR UPDATE`,
      [runId, companyId]
    );
    if (runResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll run not found.'] };
    }

    const run = runResult.rows[0];
    if (String(run.status).toLowerCase() !== 'draft' && String(run.status).toLowerCase() !== 'pending') {
      await client.query('ROLLBACK');
      return { error: [400, 'Only draft or pending payroll runs can be rebuilt from sources.'] };
    }

    const schedule = await fetchSchedule(client, companyId, Number(run.payroll_schedule_id));
    if (!schedule) {
      await client.query('ROLLBACK');
      return { error: [404, 'Payroll schedule not found.'] };
    }

    const companySettings = await fetchCompanyPayrollSettings(client, companyId);
    const periodKeys = periodDateKeysFromSchedule(run.period_month, schedule);
    const holidayDateKeys =
      periodKeys.length > 0
        ? await getCompanyHolidayDateKeysForRange(
            companyId,
            periodKeys[0],
            periodKeys[periodKeys.length - 1],
            client
          )
        : new Set();

    const employeesResult = await client.query(
      `SELECT pre.id AS run_employee_id, pre.employee_id,
              e.first_name, e.last_name, e.employment_status,
              ejd.salary, ejd.salary_template_id, ejd.payroll_schedule_id,
              ejd.department_id, ejd.work_location_id
       FROM payroll_run_employees pre
       JOIN employees e ON e.id = pre.employee_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE pre.payroll_run_id = $1
       ORDER BY pre.id ASC`,
      [runId]
    );

    let rebuilt = 0;
    const skipped = [];

    for (const row of employeesResult.rows) {
      const employee = {
        id: row.employee_id,
        first_name: row.first_name,
        last_name: row.last_name,
        employment_status: row.employment_status,
        salary: row.salary,
        salary_template_id: row.salary_template_id,
        payroll_schedule_id: row.payroll_schedule_id,
        department_id: row.department_id,
        work_location_id: row.work_location_id,
      };

      const calcResult = await buildEmployeeCalculation(
        client,
        companyId,
        employee,
        schedule,
        run.period_month,
        Boolean(run.is_off_cycle),
        companySettings,
        holidayDateKeys
      );

      if (calcResult.skipped) {
        skipped.push(calcResult.skipped);
        continue;
      }

      const runEmployeeId = Number(row.run_employee_id);
      const calculated = calcResult.calculated;

      await client.query(`DELETE FROM payroll_run_lines WHERE payroll_run_employee_id = $1`, [
        runEmployeeId,
      ]);

      await client.query(
        `UPDATE payroll_run_employees
         SET basic_salary = $1,
             present_days = $2,
             absent_days = $3,
             total_allowances = $4,
             total_deductions = $5,
             total_contributions = $6,
             gross_pay = $7,
             net_pay = $8
         WHERE id = $9`,
        [
          calculated.basic_salary,
          calculated.present_days,
          calculated.absent_days,
          calculated.total_allowances,
          calculated.total_deductions,
          calculated.total_contributions,
          calculated.gross_pay,
          calculated.net_pay,
          runEmployeeId,
        ]
      );

      for (const line of calculated.lines) {
        await client.query(
          `INSERT INTO payroll_run_lines (payroll_run_employee_id, line_kind, label, amount, source_ref)
           VALUES ($1, $2, $3, $4, $5)`,
          [runEmployeeId, line.line_kind, line.label, line.amount, line.source_ref || null]
        );
      }

      rebuilt += 1;
    }

    const totals = await computeRunTotals(client, runId);
    await client.query(
      `UPDATE payroll_runs
       SET total_gross = $1,
           total_deductions = $2,
           total_net = $3,
           skipped_employees = $4::jsonb,
           updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE id = $5`,
      [
        totals.total_gross,
        totals.total_deductions,
        totals.total_net,
        JSON.stringify(skipped),
        runId,
      ]
    );

    await client.query('COMMIT');

    const refreshed = await getById(authUser, runId);
    return {
      payroll_run: refreshed.error ? mapRunRow(run, { employee_count: rebuilt }) : refreshed,
      rebuilt_count: rebuilt,
      skipped_count: skipped.length,
      skipped,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  preview,
  create,
  list,
  getById,
  getSkipped,
  listEmployees,
  getEmployee,
  updateEmployee,
  bulkUpdate,
  buildImportTemplate,
  validateImportRows,
  importRows,
  transition,
  exportSheet,
  remove,
  rebuildDraft,
};
