const pool = require('../db');
const { utcNowForPgTimestamp, toDateKey, normalizeDateInput } = require('../utils/dateTime');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_WFH_DAYS_PER_MONTH = 8;

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWfhDates(dates) {
  if (!Array.isArray(dates)) return [];
  const unique = [];
  const seen = new Set();
  for (const value of dates) {
    const parsed = normalizeDateInput(value, { fieldName: 'date' });
    if (parsed.error || !parsed.value || seen.has(parsed.value)) continue;
    seen.add(parsed.value);
    unique.push(parsed.value);
  }
  return unique.sort();
}

function validateWfhDetails(details) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const dates = normalizeWfhDates(details.dates);
  if (dates.length === 0) {
    return { error: 'details.dates must include at least one valid date.' };
  }

  const today = getTodayDateString();
  for (const date of dates) {
    if (date < today) {
      return { error: 'WFH dates cannot be in the past.' };
    }
  }

  const reason = String(details.reason || '').trim();
  if (reason.length > 2000) {
    return { error: 'details.reason must be at most 2000 characters.' };
  }

  const workPlan = String(details.work_plan || '').trim();
  if (!workPlan) {
    return { error: 'details.work_plan is required.' };
  }
  if (workPlan.length > 2000) {
    return { error: 'details.work_plan must be at most 2000 characters.' };
  }

  return { dates, reason, workPlan };
}

async function getCompanyMaxWfhDays(client, companyId) {
  const result = await client.query(
    `SELECT max_wfh_days_per_month FROM companies WHERE id = $1`,
    [companyId]
  );
  if (result.rowCount === 0) return DEFAULT_MAX_WFH_DAYS_PER_MONTH;
  const value = Number(result.rows[0].max_wfh_days_per_month);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_WFH_DAYS_PER_MONTH;
}

async function countEmployeeWfhDaysInMonth(client, employeeId, monthAnchorDate, excludeRequestId = null) {
  const params = [employeeId, monthAnchorDate];
  let excludeClause = '';
  if (excludeRequestId) {
    params.push(excludeRequestId);
    excludeClause = ` AND r.id <> $${params.length}`;
  }

  const result = await client.query(
    `SELECT COUNT(DISTINCT w.wfh_date)::int AS total
     FROM wfh_request_details w
     JOIN requests r ON r.id = w.request_id
     WHERE r.employee_id = $1
       AND r.request_type = 'wfh'
       AND r.status IN ('pending', 'approved')
       AND date_trunc('month', w.wfh_date) = date_trunc('month', $2::date)${excludeClause}`,
    params
  );
  return result.rows[0]?.total || 0;
}

async function assertWfhMonthlyLimit(client, { employeeId, companyId, dates, excludeRequestId = null }) {
  const maxDays = await getCompanyMaxWfhDays(client, companyId);
  const months = new Map();

  for (const date of dates) {
    const monthKey = date.slice(0, 7);
    if (!months.has(monthKey)) {
      const used = await countEmployeeWfhDaysInMonth(
        client,
        employeeId,
        date,
        excludeRequestId
      );
      months.set(monthKey, { anchor: date, used });
    }
    const entry = months.get(monthKey);
    entry.requested = (entry.requested || 0) + 1;
  }

  for (const [, entry] of months) {
    const totalAfter = entry.used + entry.requested;
    if (totalAfter > maxDays) {
      return {
        error: `You have used ${entry.used}/${maxDays} WFH days this month.`,
        status: 409,
      };
    }
  }

  return { maxDays };
}

async function assertNoConflictingWfhDates(client, employeeId, dates, excludeRequestId = null) {
  const params = [employeeId, dates];
  let excludeClause = '';
  if (excludeRequestId) {
    params.push(excludeRequestId);
    excludeClause = ` AND r.id <> $${params.length}`;
  }

  const result = await client.query(
    `SELECT w.wfh_date::text AS wfh_date
     FROM wfh_request_details w
     JOIN requests r ON r.id = w.request_id
     WHERE r.employee_id = $1
       AND r.request_type = 'wfh'
       AND r.status = 'pending'
       AND w.wfh_date = ANY($2::date[])${excludeClause}`,
    params
  );

  if (result.rowCount > 0) {
    const conflictDate = toDateKey(result.rows[0].wfh_date);
    return {
      error: `You already have a pending WFH request for ${conflictDate}.`,
      status: 409,
    };
  }

  return null;
}

async function removeWfhAttendanceForDates(client, employeeId, requestId, dates) {
  if (!Array.isArray(dates) || dates.length === 0) return;

  await client.query(
    `DELETE FROM attendance
     WHERE employee_id = $1
       AND attendance_date = ANY($2::date[])
       AND remarks = $3`,
    [employeeId, dates, `wfh_request:${requestId}`]
  );
}

/** True when the employee has admin-approved WFH on this calendar date. */
async function isApprovedWfhDateForEmployee(client, employeeId, attendanceDate) {
  const dateKey = toDateKey(attendanceDate);
  if (!dateKey) return false;

  const result = await client.query(
    `SELECT 1
     FROM wfh_request_details w
     INNER JOIN requests r ON r.id = w.request_id
     WHERE r.employee_id = $1
       AND r.request_type = 'wfh'
       AND r.status = 'approved'
       AND w.wfh_date = $2::date
     LIMIT 1`,
    [employeeId, dateKey]
  );
  return result.rowCount > 0;
}

async function loadWfhDatesForRequest(client, requestId) {
  const result = await client.query(
    `SELECT wfh_date::text AS wfh_date
     FROM wfh_request_details
     WHERE request_id = $1
     ORDER BY wfh_date ASC`,
    [requestId]
  );
  return result.rows.map((row) => row.wfh_date);
}

async function loadWfhDetailsMap(requestIds) {
  if (!requestIds.length) return new Map();

  const result = await pool.query(
    `SELECT request_id, wfh_date::text AS wfh_date, reason, work_plan
     FROM wfh_request_details
     WHERE request_id = ANY($1::bigint[])
     ORDER BY wfh_date ASC`,
    [requestIds]
  );

  const map = new Map();
  for (const row of result.rows) {
    const requestId = Number(row.request_id);
    if (!map.has(requestId)) {
      map.set(requestId, {
        dates: [],
        reason: row.reason,
        work_plan: row.work_plan,
      });
    }
    map.get(requestId).dates.push(row.wfh_date);
  }
  return map;
}

async function applyWfhApproval(client, {
  employeeId,
  requestId,
  reviewedBy,
}) {
  const detailsResult = await client.query(
    `SELECT wfh_date::text AS wfh_date
     FROM wfh_request_details
     WHERE request_id = $1
     ORDER BY wfh_date ASC`,
    [requestId]
  );

  if (detailsResult.rowCount === 0) {
    throw new Error('WFH request has no dates to apply.');
  }

  const now = utcNowForPgTimestamp();
  const remarks = `wfh_request:${requestId}`;

  for (const row of detailsResult.rows) {
    const wfhDate = toDateKey(row.wfh_date);
    await client.query(
      `INSERT INTO attendance (
         employee_id, attendance_date, status, work_mode, approval_status, source, remarks, approved_by, approved_at
       )
       VALUES ($1, $2, 'present', 'remote', 'approved', 'admin', $3, $4, $5)
       ON CONFLICT (employee_id, attendance_date)
       DO UPDATE SET
         status = 'present',
         work_mode = 'remote',
         approval_status = 'approved',
         source = 'admin',
         remarks = EXCLUDED.remarks,
         approved_by = EXCLUDED.approved_by,
         approved_at = EXCLUDED.approved_at`,
      [employeeId, wfhDate, remarks, reviewedBy, now]
    );
  }
}

module.exports = {
  validateWfhDetails,
  normalizeWfhDates,
  assertWfhMonthlyLimit,
  assertNoConflictingWfhDates,
  loadWfhDetailsMap,
  applyWfhApproval,
  removeWfhAttendanceForDates,
  isApprovedWfhDateForEmployee,
  loadWfhDatesForRequest,
  countEmployeeWfhDaysInMonth,
  getCompanyMaxWfhDays,
};
