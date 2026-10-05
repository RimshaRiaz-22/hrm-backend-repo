const pool = require('../db');
const { parseOptionalDateInput } = require('../utils/dateTime');
const { getCompanyDayAttendanceCounts, getCompanyDayAttendanceSnapshot } = require('./attendancePunch.service');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PROBATION_WINDOW_DAYS = 30;
const DEFAULT_CONTRACT_WINDOW_DAYS = 30;
const DEFAULT_STALE_DAYS = 3;
const DEFAULT_LATE_LIMIT = 5;
const DEFAULT_UPCOMING_WINDOW_DAYS = 30;

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const PENDING_REQUEST_LABELS = {
  attendance_correction: 'Attendance corrections',
  wfh: 'WFH requests',
  loan: 'Loan requests',
  pf_temporary: 'PF temporary requests',
  pf_permanent: 'PF permanent requests',
  expense: 'Expense requests',
  resignation: 'Resignation requests',
  document: 'Document requests',
};

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseDashboardDate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: getTodayDateString() };
  }
  const parsed = parseOptionalDateInput(raw, 'date');
  if (parsed.error) return { error: [400, parsed.error] };
  return { value: parsed.value };
}

function parseMonth(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return { error: [400, 'month must be in YYYY-MM format.'] };
  }
  return { value };
}

function addDaysToDateString(dateString, days) {
  const cursor = new Date(`${dateString}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

function buildSummaryCard(label, value) {
  return { label, value };
}

function buildPercentPresent(checkedIn, totalEmployees) {
  if (!totalEmployees) return 0;
  return Math.round((checkedIn / totalEmployees) * 100);
}

function buildAttendanceSnapshotResponse(asOfDate, companyId, snapshot) {
  const counts = snapshot.counts;
  const totalEmployees = Number(counts.total_employees || 0);
  const checkedIn = Number(counts.checked_in || 0);
  const percentPresent = buildPercentPresent(checkedIn, totalEmployees);

  const summary = [
    buildSummaryCard('Present', `${checkedIn}/${totalEmployees}`),
    buildSummaryCard('Late', Number(counts.late || 0)),
    buildSummaryCard('Absent', Number(counts.absent || 0)),
    buildSummaryCard('On Leave', Number(counts.on_leave || 0)),
    buildSummaryCard('Percent Present', `${percentPresent}%`),
  ];

  const bars = [
    buildSummaryCard('Present', Number(counts.present || 0)),
    buildSummaryCard('Late', Number(counts.late || 0)),
    buildSummaryCard('Absent', Number(counts.absent || 0)),
    buildSummaryCard('On Leave', Number(counts.on_leave || 0)),
  ];

  return {
    as_of_date: asOfDate,
    company_id: companyId,
    total_employees: totalEmployees,
    percent_present: percentPresent,
    summary,
    bars,
    by_department: snapshot.by_department,
  };
}

function daysBetween(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function formatEmployeeName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim();
}

function getMonthStartDate(dateString) {
  const [year, month] = dateString.split('-');
  return `${year}-${month}-01`;
}

function getMonthEndDate(monthStart) {
  const [year, month] = monthStart.split('-').map(Number);
  const cursor = new Date(Date.UTC(year, month, 0));
  return cursor.toISOString().slice(0, 10);
}

function parseStaleDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_STALE_DAYS;
  }
  const parsed = parsePositiveInt(raw);
  if (!parsed) return null;
  return parsed;
}

async function fetchCompanyLateLimit(client, companyId, queryOverride) {
  const override = parsePositiveInt(queryOverride);
  if (override) return override;

  const result = await client.query(
    `SELECT attendance_settings
     FROM companies
     WHERE id = $1`,
    [companyId]
  );
  const settings =
    result.rows[0]?.attendance_settings && typeof result.rows[0].attendance_settings === 'object'
      ? result.rows[0].attendance_settings
      : {};
  const configured = Number(settings.max_late_per_month);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_LATE_LIMIT;
}

async function fetchPendingRequestCountsByType(client, companyId) {
  const result = await client.query(
    `SELECT r.request_type, COUNT(*)::int AS total
     FROM requests r
     WHERE r.company_id = $1
       AND r.status IN ('pending', 'manager_approved')
     GROUP BY r.request_type`,
    [companyId]
  );

  const counts = {
    attendance_correction: 0,
    wfh: 0,
    loan: 0,
    pf_temporary: 0,
    pf_permanent: 0,
    expense: 0,
    resignation: 0,
    document: 0,
  };

  for (const row of result.rows) {
    const type = String(row.request_type || '').trim();
    if (Object.prototype.hasOwnProperty.call(counts, type)) {
      counts[type] = Number(row.total || 0);
    }
  }

  return counts;
}

async function countPendingDocumentRequests(client, companyId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM document_requests dr
     WHERE dr.company_id = $1
       AND dr.status IN ('pending', 'manager_approved')`,
    [companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchStaleRequestSummary(client, companyId, staleDays) {
  const result = await client.query(
    `SELECT r.request_type, COUNT(*)::int AS total
     FROM requests r
     WHERE r.company_id = $1
       AND r.status = 'pending'
       AND r.submitted_at < (NOW() AT TIME ZONE 'UTC') - make_interval(days => $2::int)
     GROUP BY r.request_type`,
    [companyId, staleDays]
  );
  return result.rows.map((row) => ({
    request_type: String(row.request_type || ''),
    count: Number(row.total || 0),
  }));
}

async function fetchProbationEndingRows(client, companyId, fromDate, toDate) {
  const result = await client.query(
    `SELECT e.id AS employee_id,
            e.first_name,
            e.last_name,
            ejd.probation_end_date
     FROM employee_job_details ejd
     INNER JOIN employees e ON e.id = ejd.employee_id
     WHERE ejd.company_id = $1
       AND e.employment_status != 'exited'
       AND ejd.probation_end_date IS NOT NULL
       AND ejd.probation_end_date >= $2::date
       AND ejd.probation_end_date <= $3::date
     ORDER BY ejd.probation_end_date ASC, e.first_name ASC, e.last_name ASC`,
    [companyId, fromDate, toDate]
  );
  return result.rows;
}

async function fetchContractExpiringRows(client, companyId, fromDate, toDate) {
  const result = await client.query(
    `SELECT e.id AS employee_id,
            e.first_name,
            e.last_name,
            ejd.contract_end_date
     FROM employee_job_details ejd
     INNER JOIN employees e ON e.id = ejd.employee_id
     WHERE ejd.company_id = $1
       AND e.employment_status != 'exited'
       AND ejd.contract_end_date IS NOT NULL
       AND ejd.contract_end_date >= $2::date
       AND ejd.contract_end_date <= $3::date
     ORDER BY ejd.contract_end_date ASC, e.first_name ASC, e.last_name ASC`,
    [companyId, fromDate, toDate]
  );
  return result.rows;
}

async function fetchLateLimitExceededRows(client, companyId, monthStart, monthEnd, lateLimit) {
  const result = await client.query(
    `SELECT e.id AS employee_id,
            e.first_name,
            e.last_name,
            COUNT(DISTINCT ap.attendance_date)::int AS late_count
     FROM attendance_punches ap
     INNER JOIN employees e ON e.id = ap.employee_id
     WHERE e.company_id = $1
       AND e.employment_status != 'exited'
       AND ap.action_type = 'clock_in'
       AND LOWER(COALESCE(ap.attendance_status, '')) = 'late'
       AND ap.attendance_date >= $2::date
       AND ap.attendance_date <= $3::date
     GROUP BY e.id, e.first_name, e.last_name
     HAVING COUNT(DISTINCT ap.attendance_date) > $4
     ORDER BY late_count DESC, e.first_name ASC, e.last_name ASC`,
    [companyId, monthStart, monthEnd, lateLimit]
  );
  return result.rows;
}

function buildPendingApprovalItems(pendingLeaves, requestCounts, pendingDocumentRequests) {
  const items = [
    buildSummaryCard('Leave requests', pendingLeaves),
    buildSummaryCard(
      PENDING_REQUEST_LABELS.attendance_correction,
      requestCounts.attendance_correction
    ),
    buildSummaryCard(PENDING_REQUEST_LABELS.wfh, requestCounts.wfh),
    buildSummaryCard(PENDING_REQUEST_LABELS.loan, requestCounts.loan),
    buildSummaryCard(PENDING_REQUEST_LABELS.pf_temporary, requestCounts.pf_temporary),
    buildSummaryCard(PENDING_REQUEST_LABELS.pf_permanent, requestCounts.pf_permanent),
    buildSummaryCard(PENDING_REQUEST_LABELS.expense, requestCounts.expense),
    buildSummaryCard('Document requests', pendingDocumentRequests),
  ];

  const total =
    pendingLeaves +
    requestCounts.attendance_correction +
    requestCounts.wfh +
    requestCounts.loan +
    requestCounts.pf_temporary +
    requestCounts.pf_permanent +
    requestCounts.expense +
    requestCounts.resignation +
    requestCounts.document +
    pendingDocumentRequests;

  return { total, items };
}

function buildNeedsAttentionItems({
  asOfDate,
  staleDays,
  lateLimit,
  probationRows,
  contractRows,
  staleRequestRows,
  lateExceededRows,
}) {
  const items = [];

  for (const row of probationRows) {
    const dueDate = toDateKey(row.probation_end_date);
    const daysRemaining = daysBetween(asOfDate, dueDate);
    const name = formatEmployeeName(row);
    items.push({
      label: 'Probation ending',
      value: `${name} — ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left`,
      employee_id: Number(row.employee_id),
      employee_name: name,
      due_date: dueDate,
      days_remaining: daysRemaining,
    });
  }

  for (const row of contractRows) {
    const dueDate = toDateKey(row.contract_end_date);
    const daysRemaining = daysBetween(asOfDate, dueDate);
    const name = formatEmployeeName(row);
    items.push({
      label: 'Contract expiring',
      value: `${name} — ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left`,
      employee_id: Number(row.employee_id),
      employee_name: name,
      due_date: dueDate,
      days_remaining: daysRemaining,
    });
  }

  const staleCorrectionCount = staleRequestRows
    .filter((row) => row.request_type === 'attendance_correction')
    .reduce((sum, row) => sum + row.count, 0);

  if (staleCorrectionCount > 0) {
    items.push({
      label: 'Stale correction requests',
      value: `${staleCorrectionCount} request${staleCorrectionCount === 1 ? '' : 's'} pending over ${staleDays} days`,
      count: staleCorrectionCount,
      stale_days: staleDays,
      request_type: 'attendance_correction',
    });
  }

  const staleOtherCount = staleRequestRows
    .filter((row) => row.request_type !== 'attendance_correction')
    .reduce((sum, row) => sum + row.count, 0);

  if (staleOtherCount > 0) {
    items.push({
      label: 'Other stale requests',
      value: `${staleOtherCount} request${staleOtherCount === 1 ? '' : 's'} pending over ${staleDays} days`,
      count: staleOtherCount,
      stale_days: staleDays,
    });
  }

  for (const row of lateExceededRows) {
    const name = formatEmployeeName(row);
    const lateCount = Number(row.late_count || 0);
    items.push({
      label: 'Late limit exceeded',
      value: `${name} — ${lateCount} late${lateCount === 1 ? '' : 's'} this month`,
      employee_id: Number(row.employee_id),
      employee_name: name,
      late_count: lateCount,
      late_limit: lateLimit,
    });
  }

  return {
    total: items.length,
    items,
  };
}

function toDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatShortDate(dateString) {
  const key = toDateKey(dateString);
  if (!key) return '';
  const [, month, day] = key.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

function findAnnualOccurrencesInWindow(sourceDate, fromDate, toDate) {
  const key = toDateKey(sourceDate);
  if (!key) return [];
  const monthDay = key.slice(5);
  const fromYear = Number(fromDate.slice(0, 4));
  const toYear = Number(toDate.slice(0, 4));
  const matches = [];

  for (let year = fromYear; year <= toYear; year += 1) {
    const candidate = `${year}-${monthDay}`;
    if (candidate >= fromDate && candidate <= toDate) {
      matches.push(candidate);
    }
  }

  return matches;
}

function isDateInWindow(dateValue, fromDate, toDate) {
  const key = toDateKey(dateValue);
  if (!key) return false;
  return key >= fromDate && key <= toDate;
}

function sortUpcomingItems(items) {
  return [...items].sort((a, b) => {
    const dateCmp = String(a.event_date).localeCompare(String(b.event_date));
    if (dateCmp !== 0) return dateCmp;
    return String(a.label).localeCompare(String(b.label));
  });
}

function buildUpcomingGroup(label, items) {
  const sorted = sortUpcomingItems(items);
  return {
    label,
    total: sorted.length,
    items: sorted.map((item) => ({
      label: item.label,
      value: item.value,
    })),
  };
}

async function fetchEmployeesForUpcoming(client, companyId) {
  const result = await client.query(
    `SELECT e.id,
            e.first_name,
            e.last_name,
            e.dob,
            e.national_id_expiry,
            e.passport_expiry,
            ejd.joining_date,
            ejd.hire_date
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND e.employment_status != 'exited'
     ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC`,
    [companyId]
  );
  return result.rows;
}

function buildBirthdayItems(rows, fromDate, toDate) {
  const items = [];
  for (const row of rows) {
    const name = formatEmployeeName(row);
    for (const eventDate of findAnnualOccurrencesInWindow(row.dob, fromDate, toDate)) {
      items.push({
        label: name,
        value: formatShortDate(eventDate),
        event_date: eventDate,
      });
    }
  }
  return items;
}

function buildWorkAnniversaryItems(rows, fromDate, toDate) {
  const items = [];
  for (const row of rows) {
    const sourceDate = row.joining_date || row.hire_date;
    const sourceKey = toDateKey(sourceDate);
    if (!sourceKey) continue;

    const name = formatEmployeeName(row);
    for (const eventDate of findAnnualOccurrencesInWindow(sourceDate, fromDate, toDate)) {
      const years = Number(eventDate.slice(0, 4)) - Number(sourceKey.slice(0, 4));
      if (years <= 0) continue;
      items.push({
        label: name,
        value: `${years} year${years === 1 ? '' : 's'} on ${formatShortDate(eventDate)}`,
        event_date: eventDate,
      });
    }
  }
  return items;
}

function buildDocumentExpiryItems(rows, fromDate, toDate) {
  const items = [];

  for (const row of rows) {
    const name = formatEmployeeName(row);
    const firstName = String(row.first_name || '').trim() || name;

    if (isDateInWindow(row.national_id_expiry, fromDate, toDate)) {
      const eventDate = toDateKey(row.national_id_expiry);
      items.push({
        label: firstName,
        value: `CNIC expires ${formatShortDate(eventDate)}`,
        event_date: eventDate,
      });
    }

    if (isDateInWindow(row.passport_expiry, fromDate, toDate)) {
      const eventDate = toDateKey(row.passport_expiry);
      items.push({
        label: firstName,
        value: `Passport expires ${formatShortDate(eventDate)}`,
        event_date: eventDate,
      });
    }
  }

  return items;
}

function buildProbationUpcomingItems(rows) {
  return rows.map((row) => {
    const eventDate = toDateKey(row.probation_end_date);
    const name = formatEmployeeName(row);
    return {
      label: name,
      value: `${formatShortDate(eventDate)} (confirm or extend)`,
      event_date: eventDate,
    };
  });
}

function buildContractUpcomingItems(rows) {
  return rows.map((row) => {
    const eventDate = toDateKey(row.contract_end_date);
    const name = formatEmployeeName(row);
    return {
      label: name,
      value: formatShortDate(eventDate),
      event_date: eventDate,
    };
  });
}

async function fetchOnLeaveEmployeeIds(client, companyId, attendanceDate) {
  const result = await client.query(
    `SELECT DISTINCT lr.employee_id
     FROM leave_requests lr
     WHERE lr.company_id = $1
       AND lr.status = 'approved'
       AND lr.from_date <= $2::date
       AND lr.to_date >= $2::date`,
    [companyId, attendanceDate]
  );
  return new Set(result.rows.map((row) => Number(row.employee_id)));
}

async function countActiveEmployees(client, companyId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM employees e
     WHERE e.company_id = $1
       AND e.employment_status != 'exited'`,
    [companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function countPendingLeaveRequests(client, companyId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM leave_requests lr
     WHERE lr.company_id = $1
       AND lr.status IN ('pending', 'manager_approved')`,
    [companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function countPendingRequests(client, companyId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM requests r
     WHERE r.company_id = $1
       AND r.status IN ('pending', 'manager_approved')`,
    [companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function countApprovedLeavesInMonth(client, companyId, monthStart, monthEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM leave_requests lr
     WHERE lr.company_id = $1
       AND lr.status = 'approved'
       AND lr.created_at::date >= $2::date
       AND lr.created_at::date <= $3::date`,
    [companyId, monthStart, monthEnd]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchZeroBalanceRows(client, companyId, yearValue) {
  const result = await client.query(
    `SELECT e.id AS employee_id,
            e.first_name,
            e.last_name,
            lp.name AS policy_name,
            lb.available_days
     FROM leave_balances lb
     INNER JOIN employees e ON e.id = lb.employee_id
     INNER JOIN leave_policies lp ON lp.id = lb.leave_policy_id
     WHERE lb.company_id = $1
       AND lb.year = $2
       AND e.employment_status != 'exited'
       AND lb.available_days <= 0
     ORDER BY e.first_name ASC, e.last_name ASC, lp.name ASC`,
    [companyId, yearValue]
  );
  return result.rows;
}

async function countProbationEndingSoon(client, companyId, fromDate, toDate) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM employee_job_details ejd
     INNER JOIN employees e ON e.id = ejd.employee_id
     WHERE ejd.company_id = $1
       AND e.employment_status != 'exited'
       AND ejd.probation_end_date IS NOT NULL
       AND ejd.probation_end_date >= $2::date
       AND ejd.probation_end_date <= $3::date`,
    [companyId, fromDate, toDate]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchWorkforceByEmployeeType(client, companyId) {
  const result = await client.query(
    `SELECT COALESCE(et.label, 'Unassigned') AS label,
            COUNT(*)::int AS total
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN employee_types et ON et.id = ejd.employee_type_id
     WHERE e.company_id = $1
       AND e.employment_status != 'exited'
     GROUP BY COALESCE(et.label, 'Unassigned')
     ORDER BY label ASC`,
    [companyId]
  );
  return result.rows.map((row) => buildSummaryCard(row.label, Number(row.total || 0)));
}

async function countNewJoinersInMonth(client, companyId, monthStart, monthEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM employees e
     INNER JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND COALESCE(ejd.joining_date, ejd.hire_date) IS NOT NULL
       AND COALESCE(ejd.joining_date, ejd.hire_date) >= $2::date
       AND COALESCE(ejd.joining_date, ejd.hire_date) <= $3::date`,
    [companyId, monthStart, monthEnd]
  );
  return Number(result.rows[0]?.total || 0);
}

async function countExitsInMonth(client, companyId, monthStart, monthEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM employees e
     WHERE e.company_id = $1
       AND e.exit_date IS NOT NULL
       AND e.exit_date >= $2::date
       AND e.exit_date <= $3::date`,
    [companyId, monthStart, monthEnd]
  );
  return Number(result.rows[0]?.total || 0);
}

async function countServingNotice(client, companyId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM employees e
     WHERE e.company_id = $1
       AND e.employment_status = 'serving_notice'`,
    [companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

/**
 * GET /api/v1/hr/dashboard/summary
 * Top summary cards for the HR (company admin) dashboard.
 */
async function getHrDashboardSummary(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const probationWindowDays =
    parsePositiveInt(query.probation_days ?? query.probation_window_days) ||
    DEFAULT_PROBATION_WINDOW_DAYS;

  const asOfDate = parsedDate.value;
  const probationToDate = addDaysToDateString(asOfDate, probationWindowDays);

  const client = await pool.connect();
  try {
    const onLeaveEmployeeIds = await fetchOnLeaveEmployeeIds(client, companyId, asOfDate);

    const [
      totalEmployees,
      attendanceCounts,
      onLeaveToday,
      pendingLeaves,
      pendingRequests,
      probationEndingSoon,
    ] = await Promise.all([
      countActiveEmployees(client, companyId),
      getCompanyDayAttendanceCounts(client, companyId, asOfDate, onLeaveEmployeeIds),
      Promise.resolve(onLeaveEmployeeIds.size),
      countPendingLeaveRequests(client, companyId),
      countPendingRequests(client, companyId),
      countProbationEndingSoon(client, companyId, asOfDate, probationToDate),
    ]);

    const presentToday = Number(attendanceCounts.checked_in || 0);
    const absentToday = Number(attendanceCounts.absent || 0);

    const cards = [
      buildSummaryCard('Total Employees', totalEmployees),
      buildSummaryCard('Present Today', presentToday),
      buildSummaryCard('Absent Today', absentToday),
      buildSummaryCard('On Leave Today', onLeaveToday),
      buildSummaryCard('Pending Leaves', pendingLeaves),
      buildSummaryCard('Pending Requests', pendingRequests),
      buildSummaryCard('Payroll Status', 'Not Available'),
      buildSummaryCard('Probation Ending', probationEndingSoon),
    ];

    return {
      data: {
        as_of_date: asOfDate,
        company_id: companyId,
        probation_window_days: probationWindowDays,
        cards,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/hr/dashboard/action-required
 * Pending approvals and needs-attention items for the HR dashboard.
 */
async function getHrActionRequired(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const staleDays = parseStaleDays(query.stale_days ?? query.staleDays);
  if (staleDays === null) {
    return { error: [400, 'stale_days must be a positive integer.'] };
  }

  const probationWindowDays =
    parsePositiveInt(query.probation_days ?? query.probation_window_days) ||
    DEFAULT_PROBATION_WINDOW_DAYS;
  const contractWindowDays =
    parsePositiveInt(query.contract_days ?? query.contract_window_days) || DEFAULT_CONTRACT_WINDOW_DAYS;

  const asOfDate = parsedDate.value;
  const probationToDate = addDaysToDateString(asOfDate, probationWindowDays);
  const contractToDate = addDaysToDateString(asOfDate, contractWindowDays);
  const monthStart = getMonthStartDate(asOfDate);

  const client = await pool.connect();
  try {
    const lateLimit = await fetchCompanyLateLimit(client, companyId, query.late_limit ?? query.lateLimit);

    const [
      pendingLeaves,
      requestCounts,
      pendingDocumentRequests,
      staleRequestRows,
      probationRows,
      contractRows,
      lateExceededRows,
    ] = await Promise.all([
      countPendingLeaveRequests(client, companyId),
      fetchPendingRequestCountsByType(client, companyId),
      countPendingDocumentRequests(client, companyId),
      fetchStaleRequestSummary(client, companyId, staleDays),
      fetchProbationEndingRows(client, companyId, asOfDate, probationToDate),
      fetchContractExpiringRows(client, companyId, asOfDate, contractToDate),
      fetchLateLimitExceededRows(client, companyId, monthStart, asOfDate, lateLimit),
    ]);

    const pendingApprovals = buildPendingApprovalItems(
      pendingLeaves,
      requestCounts,
      pendingDocumentRequests
    );
    const needsAttention = buildNeedsAttentionItems({
      asOfDate,
      staleDays,
      lateLimit,
      probationRows,
      contractRows,
      staleRequestRows,
      lateExceededRows,
    });

    return {
      data: {
        as_of_date: asOfDate,
        company_id: companyId,
        stale_days: staleDays,
        probation_window_days: probationWindowDays,
        contract_window_days: contractWindowDays,
        late_limit: lateLimit,
        pending_approvals: pendingApprovals,
        needs_attention: needsAttention,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/hr/dashboard/attendance-snapshot
 * Today's attendance overview for the HR dashboard.
 */
async function getHrAttendanceSnapshot(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const asOfDate = parsedDate.value;
  const client = await pool.connect();

  try {
    const onLeaveEmployeeIds = await fetchOnLeaveEmployeeIds(client, companyId, asOfDate);
    const snapshot = await getCompanyDayAttendanceSnapshot(
      client,
      companyId,
      asOfDate,
      onLeaveEmployeeIds
    );

    return {
      data: buildAttendanceSnapshotResponse(asOfDate, companyId, snapshot),
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/hr/dashboard/upcoming
 * Upcoming birthdays, probation, contracts, anniversaries, and document expiry.
 */
async function getHrUpcoming(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.from_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const windowDays =
    parsePositiveInt(query.days ?? query.window_days) || DEFAULT_UPCOMING_WINDOW_DAYS;

  const fromDate = parsedDate.value;
  const toDate = addDaysToDateString(fromDate, windowDays);

  const client = await pool.connect();
  try {
    const [employeeRows, probationRows, contractRows] = await Promise.all([
      fetchEmployeesForUpcoming(client, companyId),
      fetchProbationEndingRows(client, companyId, fromDate, toDate),
      fetchContractExpiringRows(client, companyId, fromDate, toDate),
    ]);

    const groups = [
      buildUpcomingGroup('Birthdays', buildBirthdayItems(employeeRows, fromDate, toDate)),
      buildUpcomingGroup('Probation Ending', buildProbationUpcomingItems(probationRows)),
      buildUpcomingGroup('Contract Renewals', buildContractUpcomingItems(contractRows)),
      buildUpcomingGroup('Work Anniversaries', buildWorkAnniversaryItems(employeeRows, fromDate, toDate)),
      buildUpcomingGroup('Document Expiry', buildDocumentExpiryItems(employeeRows, fromDate, toDate)),
    ];

    const totalItems = groups.reduce((sum, group) => sum + group.total, 0);

    return {
      data: {
        from_date: fromDate,
        to_date: toDate,
        company_id: companyId,
        window_days: windowDays,
        total_items: totalItems,
        groups,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/hr/dashboard/leave-overview
 * Company leave snapshot for dashboard cards.
 */
async function getHrLeaveOverview(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const parsedMonth = parseMonth(query.month);
  if (parsedMonth.error) return { error: parsedMonth.error };

  const asOfDate = parsedDate.value;
  const monthValue = parsedMonth.value || asOfDate.slice(0, 7);
  const monthStart = `${monthValue}-01`;
  const monthEnd = getMonthEndDate(monthStart);
  const yearValue = Number(monthValue.slice(0, 4));

  const client = await pool.connect();
  try {
    const onLeaveEmployeeIds = await fetchOnLeaveEmployeeIds(client, companyId, asOfDate);

    const [approvedThisMonth, pendingApproval, zeroBalanceRows] = await Promise.all([
      countApprovedLeavesInMonth(client, companyId, monthStart, monthEnd),
      countPendingLeaveRequests(client, companyId),
      fetchZeroBalanceRows(client, companyId, yearValue),
    ]);

    const summary = [
      buildSummaryCard('On Leave Today', onLeaveEmployeeIds.size),
      buildSummaryCard('Approved This Month', approvedThisMonth),
      buildSummaryCard('Pending Approval', pendingApproval),
      buildSummaryCard('Employees with Zero Balance', zeroBalanceRows.length),
    ];

    const zeroBalanceEmployees = zeroBalanceRows.map((row) => ({
      label: formatEmployeeName(row),
      value: `${row.policy_name} (${Number(row.available_days || 0)} days)`,
    }));

    return {
      data: {
        as_of_date: asOfDate,
        month: monthValue,
        company_id: companyId,
        summary,
        zero_balance_employees: zeroBalanceEmployees,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/hr/dashboard/workforce
 * Headcount snapshot for the HR dashboard.
 */
async function getHrWorkforce(companyId, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const parsedMonth = parseMonth(query.month);
  if (parsedMonth.error) return { error: parsedMonth.error };

  const asOfDate = parsedDate.value;
  const monthValue = parsedMonth.value || asOfDate.slice(0, 7);
  const monthStart = `${monthValue}-01`;
  const monthEnd = getMonthEndDate(monthStart);

  const client = await pool.connect();
  try {
    const [totalActive, byEmployeeType, newJoiners, exits, servingNotice] = await Promise.all([
      countActiveEmployees(client, companyId),
      fetchWorkforceByEmployeeType(client, companyId),
      countNewJoinersInMonth(client, companyId, monthStart, monthEnd),
      countExitsInMonth(client, companyId, monthStart, monthEnd),
      countServingNotice(client, companyId),
    ]);

    return {
      data: {
        as_of_date: asOfDate,
        month: monthValue,
        company_id: companyId,
        summary: [buildSummaryCard('Total Active', totalActive)],
        by_employee_type: byEmployeeType,
        this_month: [
          buildSummaryCard('New Joiners', newJoiners),
          buildSummaryCard('Exits', exits),
          buildSummaryCard('Serving Notice', servingNotice),
        ],
      },
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getHrDashboardSummary,
  getHrActionRequired,
  getHrAttendanceSnapshot,
  getHrUpcoming,
  getHrLeaveOverview,
  getHrWorkforce,
};
