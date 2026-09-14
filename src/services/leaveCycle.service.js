const pool = require('../db');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Anniversary leave-cycle helpers.
 * Legacy calendar-year balances (period_start IS NULL) are never migrated or rewritten.
 */

function toDateOnlyString(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseDateParts(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDateKey(year, month, day) {
  const safeDay = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

function addDaysToDateKey(dateKey, days) {
  const { y, m, d } = parseDateParts(dateKey);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolve policy anchor: joining_date → hire_date → employee created_at.
 */
function resolveAnchorDate({ joiningDate = null, hireDate = null, createdAt = null } = {}) {
  return (
    toDateOnlyString(joiningDate) ||
    toDateOnlyString(hireDate) ||
    toDateOnlyString(createdAt) ||
    new Date().toISOString().slice(0, 10)
  );
}

/**
 * Current anniversary cycle for an anchor date as of a given date (default: today UTC).
 * Example: join 2025-07-05 → 2025-07-05..2026-07-04, renewal 2026-07-05
 */
function computePolicyCycle(anchorDateKey, asOfDateKey = null) {
  const anchor = toDateOnlyString(anchorDateKey);
  const asOf = toDateOnlyString(asOfDateKey) || new Date().toISOString().slice(0, 10);
  if (!anchor) return null;

  const anchorParts = parseDateParts(anchor);
  const asOfParts = parseDateParts(asOf);

  let periodStartYear = asOfParts.y;
  const anniversaryThisYear = buildDateKey(periodStartYear, anchorParts.m, anchorParts.d);
  if (asOf < anniversaryThisYear) {
    periodStartYear -= 1;
  }

  // Never start a cycle before the actual joining/anchor date.
  if (periodStartYear < anchorParts.y) {
    periodStartYear = anchorParts.y;
  }

  const periodStart = buildDateKey(periodStartYear, anchorParts.m, anchorParts.d);
  const renewalDate = buildDateKey(periodStartYear + 1, anchorParts.m, anchorParts.d);
  const periodEnd = addDaysToDateKey(renewalDate, -1);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    renewal_date: renewalDate,
    year: periodStartYear,
  };
}

function nextCycleFrom(periodStartKey, anchorDateKey) {
  const anchor = parseDateParts(toDateOnlyString(anchorDateKey) || periodStartKey);
  const start = parseDateParts(periodStartKey);
  const periodStart = buildDateKey(start.y + 1, anchor.m, anchor.d);
  const renewalDate = buildDateKey(start.y + 2, anchor.m, anchor.d);
  const periodEnd = addDaysToDateKey(renewalDate, -1);
  return {
    period_start: periodStart,
    period_end: periodEnd,
    renewal_date: renewalDate,
    year: start.y + 1,
  };
}

async function fetchEmployeeAnchorRows(db, companyId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const result = await db.query(
    `SELECT e.id,
            e.created_at,
            ejd.joining_date,
            ejd.hire_date
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1 AND e.id = ANY($2::bigint[])`,
    [companyId, employeeIds]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.id), {
      anchor: resolveAnchorDate({
        joiningDate: row.joining_date,
        hireDate: row.hire_date,
        createdAt: row.created_at,
      }),
    });
  }
  return map;
}

/**
 * Grant anniversary balances for eligible employees.
 * Skips: same period already exists, legacy same-year row, or another active anniversary cycle.
 */
async function grantAnniversaryBalancesToEmployees(
  client,
  companyId,
  policyId,
  employeeIds,
  daysPerYear,
  nowUtc,
  asOfDateKey = null
) {
  if (!employeeIds.length) return { granted: 0 };
  const anchors = await fetchEmployeeAnchorRows(client, companyId, employeeIds);
  let granted = 0;

  for (const employeeId of employeeIds) {
    const anchorInfo = anchors.get(Number(employeeId));
    const cycle = computePolicyCycle(anchorInfo?.anchor, asOfDateKey);
    if (!cycle) continue;

    const insert = await client.query(
      `INSERT INTO leave_balances (
         company_id, employee_id, leave_policy_id, year,
         total_days, used_days, available_days,
         period_start, period_end, renewal_date, cycle_status,
         created_at, updated_at
       )
       SELECT $1, $2, $3, $4, $5, 0, $5, $6::date, $7::date, $8::date, 'active', $9::timestamp, $9::timestamp
       WHERE NOT EXISTS (
         SELECT 1 FROM leave_balances lb
         WHERE lb.employee_id = $2
           AND lb.leave_policy_id = $3
           AND (
             (lb.period_start IS NOT NULL AND lb.period_start = $6::date)
             OR (lb.period_start IS NULL AND lb.year = $4)
             OR (COALESCE(lb.cycle_status, 'active') = 'active' AND lb.period_start IS NOT NULL)
           )
       )
       ON CONFLICT (employee_id, leave_policy_id, year) DO NOTHING
       RETURNING id`,
      [
        companyId,
        employeeId,
        policyId,
        cycle.year,
        daysPerYear,
        cycle.period_start,
        cycle.period_end,
        cycle.renewal_date,
        nowUtc,
      ]
    );
    if (insert.rowCount > 0) granted += 1;
  }

  return { granted };
}

async function grantActivePolicyBalancesForEmployee(
  client,
  companyId,
  employeeId,
  nowUtc,
  departmentId = null,
  designationId = null,
  anchorOverride = null
) {
  let anchor = toDateOnlyString(anchorOverride);
  if (!anchor) {
    const anchors = await fetchEmployeeAnchorRows(client, companyId, [employeeId]);
    anchor = anchors.get(Number(employeeId))?.anchor;
  }
  const cycle = computePolicyCycle(anchor);
  if (!cycle) return;

  await client.query(
    `INSERT INTO leave_balances (
       company_id, employee_id, leave_policy_id, year,
       total_days, used_days, available_days,
       period_start, period_end, renewal_date, cycle_status,
       created_at, updated_at
     )
     SELECT $1, $2, lp.id, $3, lp.days_per_year, 0, lp.days_per_year,
            $4::date, $5::date, $6::date, 'active', $7::timestamp, $7::timestamp
     FROM leave_policies lp
     WHERE lp.company_id = $1 AND lp.status = 'active'
       AND (
         EXISTS (
           SELECT 1 FROM leave_policy_eligible_employees el
           WHERE el.leave_policy_id = lp.id AND el.employee_id = $2
         )
         OR (
           NOT EXISTS (SELECT 1 FROM leave_policy_eligible_employees el2 WHERE el2.leave_policy_id = lp.id)
           AND (lp.eligible_department_id IS NULL OR lp.eligible_department_id = $8::bigint)
           AND (lp.eligible_designation_id IS NULL OR lp.eligible_designation_id = $9::bigint)
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM leave_balances lb
         WHERE lb.employee_id = $2
           AND lb.leave_policy_id = lp.id
           AND (
             (lb.period_start IS NOT NULL AND lb.period_start = $4::date)
             OR (lb.period_start IS NULL AND lb.year = $3)
             OR (COALESCE(lb.cycle_status, 'active') = 'active' AND lb.period_start IS NOT NULL)
           )
       )
     ON CONFLICT (employee_id, leave_policy_id, year) DO NOTHING`,
    [
      companyId,
      employeeId,
      cycle.year,
      cycle.period_start,
      cycle.period_end,
      cycle.renewal_date,
      nowUtc,
      departmentId,
      designationId,
    ]
  );
}

async function writeCycleHistory(client, balanceRow, closedReason, nowUtc) {
  if (!balanceRow?.period_start) return;
  await client.query(
    `INSERT INTO leave_policy_cycle_history (
       company_id, employee_id, leave_policy_id, leave_balance_id,
       period_start, period_end, renewal_date,
       total_days, used_days, available_days, closed_reason, created_at
     ) VALUES (
       $1, $2, $3, $4, $5::date, $6::date, $7::date, $8, $9, $10, $11, $12::timestamp
     )
     ON CONFLICT (employee_id, leave_policy_id, period_start) DO NOTHING`,
    [
      balanceRow.company_id,
      balanceRow.employee_id,
      balanceRow.leave_policy_id,
      balanceRow.id,
      balanceRow.period_start,
      balanceRow.period_end,
      balanceRow.renewal_date,
      balanceRow.total_days,
      balanceRow.used_days,
      balanceRow.available_days,
      closedReason,
      nowUtc,
    ]
  );
}

async function expireBalanceRow(client, balanceRow, closedReason, nowUtc) {
  await writeCycleHistory(client, balanceRow, closedReason, nowUtc);
  await client.query(
    `UPDATE leave_balances
     SET cycle_status = 'expired',
         available_days = 0,
         total_days = used_days,
         updated_at = $1::timestamp
     WHERE id = $2`,
    [nowUtc, balanceRow.id]
  );
}

/**
 * Expire due anniversary balances and grant the next cycle with a fresh full balance.
 * Unused leave expires (available → 0). Duplicate renewals are skipped via unique period.
 */
async function processLeaveCycleRenewals({ force = false } = {}) {
  const nowUtc = utcNowForPgTimestamp();
  const today = new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  let renewed = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    const due = await client.query(
      `SELECT lb.*,
              COALESCE(ejd.joining_date, ejd.hire_date, e.created_at::date) AS anchor_date,
              lp.days_per_year,
              lp.status AS policy_status
       FROM leave_balances lb
       INNER JOIN employees e ON e.id = lb.employee_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       INNER JOIN leave_policies lp ON lp.id = lb.leave_policy_id
       WHERE lb.period_start IS NOT NULL
         AND COALESCE(lb.cycle_status, 'active') = 'active'
         AND lb.renewal_date IS NOT NULL
         AND lb.renewal_date <= $1::date
       ORDER BY lb.id
       FOR UPDATE OF lb`,
      [today]
    );

    for (const row of due.rows) {
      await expireBalanceRow(client, row, 'renewed', nowUtc);

      if (row.policy_status !== 'active') {
        skipped += 1;
        continue;
      }

      const next = nextCycleFrom(toDateOnlyString(row.period_start), row.anchor_date);
      const insert = await client.query(
        `INSERT INTO leave_balances (
           company_id, employee_id, leave_policy_id, year,
           total_days, used_days, available_days,
           period_start, period_end, renewal_date, cycle_status,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 0, $5, $6::date, $7::date, $8::date, 'active', $9::timestamp, $9::timestamp
         )
         ON CONFLICT (employee_id, leave_policy_id, year) DO NOTHING
         RETURNING id`,
        [
          row.company_id,
          row.employee_id,
          row.leave_policy_id,
          next.year,
          row.days_per_year,
          next.period_start,
          next.period_end,
          next.renewal_date,
          nowUtc,
        ]
      );

      if (insert.rowCount === 0) {
        // Period unique may still block; try explicit period conflict path.
        const retry = await client.query(
          `INSERT INTO leave_balances (
             company_id, employee_id, leave_policy_id, year,
             total_days, used_days, available_days,
             period_start, period_end, renewal_date, cycle_status,
             created_at, updated_at
           )
           SELECT $1, $2, $3, $4, $5, 0, $5, $6::date, $7::date, $8::date, 'active', $9::timestamp, $9::timestamp
           WHERE NOT EXISTS (
             SELECT 1 FROM leave_balances lb
             WHERE lb.employee_id = $2 AND lb.leave_policy_id = $3 AND lb.period_start = $6::date
           )
           ON CONFLICT (employee_id, leave_policy_id, year) DO NOTHING
           RETURNING id`,
          [
            row.company_id,
            row.employee_id,
            row.leave_policy_id,
            next.year,
            row.days_per_year,
            next.period_start,
            next.period_end,
            next.renewal_date,
            nowUtc,
          ]
        );
        if (retry.rowCount > 0) renewed += 1;
        else skipped += 1;
      } else {
        renewed += 1;
      }
    }

    await client.query('COMMIT');
    if (force || renewed > 0 || skipped > 0) {
      console.log(
        `[leave-cycle-cron] renewed=${renewed} skipped=${skipped} due=${due.rowCount} as_of=${today}`
      );
    }
    return { renewed, skipped, due: due.rowCount, as_of: today };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * When joining/hire date changes: close active anniversary cycles and rebuild current period.
 * Legacy calendar-year rows (period_start IS NULL) are left untouched.
 */
async function recalculateEmployeeLeaveCycles(client, companyId, employeeId, nowUtc, anchorOverride = null) {
  const active = await client.query(
    `SELECT lb.*, lp.days_per_year, lp.status AS policy_status
     FROM leave_balances lb
     INNER JOIN leave_policies lp ON lp.id = lb.leave_policy_id
     WHERE lb.company_id = $1
       AND lb.employee_id = $2
       AND lb.period_start IS NOT NULL
       AND COALESCE(lb.cycle_status, 'active') = 'active'
     FOR UPDATE OF lb`,
    [companyId, employeeId]
  );

  for (const row of active.rows) {
    await expireBalanceRow(client, row, 'joining_date_changed', nowUtc);
  }

  const job = await client.query(
    `SELECT ejd.department_id, ejd.designation_id, ejd.joining_date, ejd.hire_date, e.created_at
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.id = $1 AND e.company_id = $2`,
    [employeeId, companyId]
  );
  if (job.rowCount === 0) return { recalculated: active.rowCount };

  const row = job.rows[0];
  const anchor =
    toDateOnlyString(anchorOverride) ||
    resolveAnchorDate({
      joiningDate: row.joining_date,
      hireDate: row.hire_date,
      createdAt: row.created_at,
    });

  await grantActivePolicyBalancesForEmployee(
    client,
    companyId,
    employeeId,
    nowUtc,
    row.department_id,
    row.designation_id,
    anchor
  );

  return { recalculated: active.rowCount };
}

function mapCycleHistoryRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    leave_policy_id: Number(row.leave_policy_id),
    leave_balance_id: row.leave_balance_id != null ? Number(row.leave_balance_id) : null,
    employee: {
      id: Number(row.employee_id),
      employee_code: row.employee_code ?? null,
      first_name: row.employee_first_name,
      last_name: row.employee_last_name,
      email: row.employee_email ?? null,
    },
    leave_policy: {
      id: Number(row.leave_policy_id),
      name: row.leave_policy_name,
      code: row.leave_policy_code,
      paid_status: row.leave_policy_paid_status,
    },
    period_start: toDateOnlyString(row.period_start),
    period_end: toDateOnlyString(row.period_end),
    renewal_date: toDateOnlyString(row.renewal_date),
    total_days: Number(row.total_days),
    used_days: Number(row.used_days),
    available_days: Number(row.available_days),
    closed_reason: row.closed_reason,
    created_at: toUtcIsoString(row.created_at),
  };
}

async function getLeavePolicyCycleHistory(companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId];
  const filters = ['h.company_id = $1'];
  let idx = 2;

  const leavePolicyId = parsePositiveInt(query.leave_policy_id);
  if (query.leave_policy_id !== undefined && query.leave_policy_id !== '' && !leavePolicyId) {
    return { error: [400, 'leave_policy_id must be a positive integer.'] };
  }
  if (leavePolicyId) {
    filters.push(`h.leave_policy_id = $${idx++}`);
    values.push(leavePolicyId);
  }

  const employeeId = parsePositiveInt(query.employee_id);
  if (query.employee_id !== undefined && query.employee_id !== '' && !employeeId) {
    return { error: [400, 'employee_id must be a positive integer.'] };
  }
  if (employeeId) {
    filters.push(`h.employee_id = $${idx++}`);
    values.push(employeeId);
  }

  const search = query.search !== undefined ? String(query.search).trim() : '';
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

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM leave_policy_cycle_history h
     INNER JOIN employees e ON e.id = h.employee_id
     INNER JOIN leave_policies lp ON lp.id = h.leave_policy_id
     WHERE ${whereSql}`,
    values
  );
  const totalItems = Number(countResult.rows[0]?.total || 0);
  const meta = buildListPaginationMeta(totalItems, listPagination);

  let result;
  if (listPagination.noPagination) {
    result = await pool.query(
      `SELECT h.*,
              e.employee_code,
              e.first_name AS employee_first_name,
              e.last_name AS employee_last_name,
              e.work_email AS employee_email,
              lp.name AS leave_policy_name,
              lp.code AS leave_policy_code,
              lp.paid_status AS leave_policy_paid_status
       FROM leave_policy_cycle_history h
       INNER JOIN employees e ON e.id = h.employee_id
       INNER JOIN leave_policies lp ON lp.id = h.leave_policy_id
       WHERE ${whereSql}
       ORDER BY h.created_at DESC, h.id DESC`,
      values
    );
  } else {
    values.push(listPagination.pagination.limit, listPagination.pagination.offset);
    result = await pool.query(
      `SELECT h.*,
              e.employee_code,
              e.first_name AS employee_first_name,
              e.last_name AS employee_last_name,
              e.work_email AS employee_email,
              lp.name AS leave_policy_name,
              lp.code AS leave_policy_code,
              lp.paid_status AS leave_policy_paid_status
       FROM leave_policy_cycle_history h
       INNER JOIN employees e ON e.id = h.employee_id
       INNER JOIN leave_policies lp ON lp.id = h.leave_policy_id
       WHERE ${whereSql}
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );
  }

  return {
    leave_policy_cycle_history: result.rows.map(mapCycleHistoryRow),
    meta,
    pagination: meta,
  };
}

module.exports = {
  toDateOnlyString,
  resolveAnchorDate,
  computePolicyCycle,
  nextCycleFrom,
  grantAnniversaryBalancesToEmployees,
  grantActivePolicyBalancesForEmployee,
  processLeaveCycleRenewals,
  recalculateEmployeeLeaveCycles,
  getLeavePolicyCycleHistory,
  writeCycleHistory,
  expireBalanceRow,
};
