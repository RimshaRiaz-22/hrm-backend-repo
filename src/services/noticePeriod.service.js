const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { toDateKey, parseOptionalDateInput } = require('../utils/dateTime');
const {
  getTodayDateString,
  daysBetween,
  HR_RESIGNATION_APPROVE_ROLES,
} = require('./resignationRequest.service');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const NOTICE_PROCESS_DEBOUNCE_MS = 60 * 1000;

let lastNoticeProcessAt = 0;
let noticeProcessInFlight = null;

const HR_NOTICE_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
]);

async function getHrReviewerContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!HR_NOTICE_ROLES.has(user.role)) {
    return { error: 'You do not have permission to view notice periods.' };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.' };
  }
  return { user };
}

async function createHrExitAlert(client, {
  companyId,
  employeeId,
  noticePeriodId,
  alertType,
  message,
}) {
  await client.query(
    `INSERT INTO hr_exit_alerts (
       company_id, employee_id, notice_period_id, alert_type, message
     )
     VALUES ($1, $2, $3, $4, $5)`,
    [companyId, employeeId, noticePeriodId, alertType, message]
  );
}

async function applyEmployeeExit(client, {
  employeeId,
  companyId,
  noticePeriodId,
  employeeName,
  exitDate,
  skipAlert = false,
  alertMessage,
}) {
  await client.query(
    `UPDATE employees
     SET employment_status = 'exited',
         exit_date = $1,
         last_working_date = $1,
         final_settlement_pending = true
     WHERE id = $2`,
    [exitDate, employeeId]
  );

  await client.query(
    `UPDATE users
     SET is_active = false,
         updated_at = CURRENT_TIMESTAMP
     WHERE employee_id = $1`,
    [employeeId]
  );

  if (!skipAlert) {
    await createHrExitAlert(client, {
      companyId,
      employeeId,
      noticePeriodId,
      alertType: 'final_settlement',
      message:
        alertMessage ||
        `${employeeName} has exited. Please run final settlement payroll.`,
    });
  }
}

async function completeEmployeeExit(client, {
  employeeId,
  companyId,
  noticePeriodId,
  employeeName,
  skipAlert = false,
}) {
  const today = getTodayDateString();

  await client.query(
    `UPDATE notice_periods
     SET status = 'completed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [noticePeriodId]
  );

  await applyEmployeeExit(client, {
    employeeId,
    companyId,
    noticePeriodId,
    employeeName,
    exitDate: today,
    skipAlert,
    alertMessage: `${employeeName} has completed their notice period today. Please run final settlement payroll.`,
  });
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseDateOnly(value) {
  const parsed = parseOptionalDateInput(value, 'date');
  if (parsed.error || !parsed.value) return null;
  return parsed.value;
}

async function waiveNoticePeriod(auth, noticePeriodId, body = {}) {
  const reviewer = await getHrReviewerContext(auth);
  if (reviewer.error) {
    return { error: reviewer.error, status: 403 };
  }
  if (!HR_RESIGNATION_APPROVE_ROLES.has(reviewer.user.role)) {
    return { error: 'Only HR or admin can waive a notice period.', status: 403 };
  }

  const id = parsePositiveInt(noticePeriodId);
  if (!id) {
    return { error: 'Invalid notice period id.', status: 400 };
  }

  const waiveReason = String(body?.waive_reason || body?.reason || '').trim();
  if (!waiveReason) {
    return { error: 'waive_reason is required.', status: 400 };
  }
  if (waiveReason.length > 2000) {
    return { error: 'waive_reason must be at most 2000 characters.', status: 400 };
  }

  const today = getTodayDateString();
  const lastWorkingDate = parseDateOnly(body?.last_working_date) || today;
  if (lastWorkingDate < today) {
    return { error: 'last_working_date cannot be in the past.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [id];
    let companyFilter = '';
    if (reviewer.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(reviewer.user.company_id);
      companyFilter = ` AND e.company_id = $${params.length}`;
    }

    const rowResult = await client.query(
      `SELECT np.id,
              np.employee_id,
              np.request_id,
              np.notice_start_date,
              np.notice_end_date,
              np.status,
              e.company_id,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM notice_periods np
       JOIN employees e ON e.id = np.employee_id
       WHERE np.id = $1${companyFilter}
       FOR UPDATE OF np`,
      params
    );

    if (!rowResult.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Notice period not found.', status: 404 };
    }

    const row = rowResult.rows[0];
    if (row.status !== 'serving') {
      await client.query('ROLLBACK');
      return { error: `Notice period is already ${row.status}.`, status: 409 };
    }

    const scheduledEndDate = toDateKey(row.notice_end_date);
    const noticeStartDate = toDateKey(row.notice_start_date);
    if (lastWorkingDate < noticeStartDate) {
      await client.query('ROLLBACK');
      return { error: 'last_working_date cannot be before the notice start date.', status: 400 };
    }
    if (lastWorkingDate > scheduledEndDate) {
      await client.query('ROLLBACK');
      return {
        error: 'last_working_date cannot be after the scheduled last working day.',
        status: 400,
      };
    }

    const employeeId = Number(row.employee_id);
    const companyId = Number(row.company_id);
    const employeeName = row.employee_name || 'Employee';
    const now = new Date();

    await client.query(
      `UPDATE notice_periods
       SET status = 'waived',
           notice_end_date = $1,
           waive_reason = $2,
           waived_by = $3,
           waived_at = $4,
           updated_at = $4
       WHERE id = $5`,
      [lastWorkingDate, waiveReason, reviewer.user.id, now, id]
    );

    await client.query(
      `UPDATE resignation_details
       SET calculated_last_working_date = $1
       WHERE request_id = $2`,
      [lastWorkingDate, row.request_id]
    );

    if (lastWorkingDate <= today) {
      await applyEmployeeExit(client, {
        employeeId,
        companyId,
        noticePeriodId: id,
        employeeName,
        exitDate: lastWorkingDate,
        alertMessage: `${employeeName}'s notice period was waived. Please run final settlement payroll.`,
      });
    } else {
      await client.query(
        `UPDATE employees
         SET last_working_date = $1
         WHERE id = $2`,
        [lastWorkingDate, employeeId]
      );
      await createHrExitAlert(client, {
        companyId,
        employeeId,
        noticePeriodId: id,
        alertType: 'final_settlement',
        message: `${employeeName}'s notice period was waived. Last working day is ${lastWorkingDate}. Plan exit and final settlement.`,
      });
    }

    await client.query('COMMIT');

    const listResult = await listNoticePeriods(auth, { status: 'all' });
    const updated = listResult.data?.items?.find((item) => item.id === id) || null;
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processWaivedNoticePeriodExits(client, today) {
  const result = await client.query(
    `SELECT np.id AS notice_period_id,
            np.employee_id,
            np.notice_end_date,
            e.company_id,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM notice_periods np
     JOIN employees e ON e.id = np.employee_id
     WHERE np.status = 'waived'
       AND e.employment_status = 'serving_notice'
       AND np.notice_end_date <= $1::date`,
    [today]
  );

  for (const row of result.rows) {
    const noticePeriodId = Number(row.notice_period_id);
    const employeeId = Number(row.employee_id);
    const companyId = Number(row.company_id);
    const employeeName = row.employee_name || 'Employee';
    const exitDate = toDateKey(row.notice_end_date);

    await applyEmployeeExit(client, {
      employeeId,
      companyId,
      noticePeriodId,
      employeeName,
      exitDate,
      skipAlert: true,
    });

    await createHrExitAlert(client, {
      companyId,
      employeeId,
      noticePeriodId,
      alertType: 'final_settlement',
      message: `Today is ${employeeName}'s waived last working day. Please run final settlement.`,
    });
  }
}

async function ensureNoticePeriodsProcessed({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastNoticeProcessAt < NOTICE_PROCESS_DEBOUNCE_MS) {
    return;
  }
  if (noticeProcessInFlight) {
    await noticeProcessInFlight;
    return;
  }

  noticeProcessInFlight = processNoticePeriodsDaily()
    .then(() => {
      lastNoticeProcessAt = Date.now();
    })
    .finally(() => {
      noticeProcessInFlight = null;
    });

  await noticeProcessInFlight;
}

async function processNoticePeriodsDaily() {
  const today = getTodayDateString();

  const waiveClient = await pool.connect();
  try {
    await waiveClient.query('BEGIN');
    await processWaivedNoticePeriodExits(waiveClient, today);
    await waiveClient.query('COMMIT');
  } catch (error) {
    await waiveClient.query('ROLLBACK');
    console.error('[notice-period-cron] waived exits failed:', error.message);
  } finally {
    waiveClient.release();
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT np.id AS notice_period_id,
              np.employee_id,
              np.notice_end_date,
              np.alert_7d_sent,
              np.alert_final_sent,
              e.company_id,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM notice_periods np
       JOIN employees e ON e.id = np.employee_id
       WHERE np.status = 'serving'`
    );

    for (const row of result.rows) {
      const noticeEndDate = toDateKey(row.notice_end_date);
      const daysRemaining = daysBetween(today, noticeEndDate);
      const employeeName = row.employee_name || 'Employee';
      const companyId = Number(row.company_id);
      const employeeId = Number(row.employee_id);
      const noticePeriodId = Number(row.notice_period_id);

      if (daysRemaining == null) continue;

      await client.query('BEGIN');

      try {
        if (daysRemaining === 7 && !row.alert_7d_sent) {
          await createHrExitAlert(client, {
            companyId,
            employeeId,
            noticePeriodId,
            alertType: '7_day_warning',
            message: `${employeeName}'s last working day is in 7 days (${noticeEndDate}). Plan exit and replacement.`,
          });
          await client.query(
            `UPDATE notice_periods
             SET alert_7d_sent = true, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [noticePeriodId]
          );
        }

        if (today >= noticeEndDate) {
          if (!row.alert_final_sent) {
            await createHrExitAlert(client, {
              companyId,
              employeeId,
              noticePeriodId,
              alertType: 'final_settlement',
              message: `Today is ${employeeName}'s last working day. Please run final settlement.`,
            });
            await client.query(
              `UPDATE notice_periods
               SET alert_final_sent = true, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [noticePeriodId]
            );
          }

          await completeEmployeeExit(client, {
            employeeId,
            companyId,
            noticePeriodId,
            employeeName,
            skipAlert: true,
          });
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[notice-period-cron] row failed:', noticePeriodId, error.message);
      }
    }
  } finally {
    client.release();
  }
}

async function listNoticePeriods(auth, query = {}) {
  const [reviewer] = await Promise.all([
    getHrReviewerContext(auth),
    ensureNoticePeriodsProcessed(),
  ]);
  if (reviewer.error) {
    return { error: reviewer.error, status: 403 };
  }

  const status = String(query.status || 'serving').trim().toLowerCase();
  const searchTerm = String(query.search || query.employee_name || query.email || '').trim();
  const conditions = [];
  const params = [];

  if (status !== 'all') {
    params.push(status);
    conditions.push(`np.status = $${params.length}`);
  }

  if (reviewer.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(reviewer.user.company_id);
    conditions.push(`e.company_id = $${params.length}`);
  }

  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    const searchIndex = params.length;
    conditions.push(`(
      e.first_name ILIKE $${searchIndex}
      OR e.last_name ILIKE $${searchIndex}
      OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex}
      OR e.employee_code ILIKE $${searchIndex}
      OR e.work_email ILIKE $${searchIndex}
    )`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const today = getTodayDateString();

  const listResult = await pool.query(
    `SELECT np.id,
            np.employee_id,
            np.request_id,
            np.notice_start_date,
            np.notice_end_date,
            np.status,
            np.waive_reason,
            np.waived_at,
            np.created_at,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_code,
            e.work_email AS employee_email,
            e.employment_status
     FROM notice_periods np
     JOIN employees e ON e.id = np.employee_id
     ${whereClause}
     ORDER BY np.notice_end_date ASC, np.id ASC`,
    params
  );

  const items = listResult.rows.map((row) => {
    const noticeEndDate = toDateKey(row.notice_end_date);
    const daysRemaining = Math.max(0, daysBetween(today, noticeEndDate) ?? 0);
    const isStillOnNotice =
      row.status === 'serving' ||
      (row.status === 'waived' && row.employment_status === 'serving_notice');
    return {
      id: Number(row.id),
      employee_id: Number(row.employee_id),
      request_id: Number(row.request_id),
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      employee_email: row.employee_email,
      employment_status: row.employment_status,
      notice_start_date: toDateKey(row.notice_start_date),
      notice_end_date: noticeEndDate,
      days_remaining: isStillOnNotice ? daysRemaining : null,
      status: row.status,
      waive_reason: row.waive_reason || null,
      waived_at: row.waived_at || null,
      created_at: row.created_at,
    };
  });

  return { data: { items } };
}

async function listHrExitAlerts(auth, query = {}) {
  const [reviewer] = await Promise.all([
    getHrReviewerContext(auth),
    ensureNoticePeriodsProcessed(),
  ]);
  if (reviewer.error) {
    return { error: reviewer.error, status: 403 };
  }

  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const conditions = [];
  const params = [];

  if (reviewer.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(reviewer.user.company_id);
    conditions.push(`a.company_id = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const result = await pool.query(
    `SELECT a.id,
            a.alert_type,
            a.message,
            a.created_at,
            e.first_name || ' ' || e.last_name AS employee_name
     FROM hr_exit_alerts a
     JOIN employees e ON e.id = a.employee_id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return {
    data: {
      items: result.rows.map((row) => ({
        id: Number(row.id),
        alert_type: row.alert_type,
        message: row.message,
        employee_name: row.employee_name,
        created_at: row.created_at,
      })),
    },
  };
}

module.exports = {
  processNoticePeriodsDaily,
  ensureNoticePeriodsProcessed,
  listNoticePeriods,
  listHrExitAlerts,
  waiveNoticePeriod,
  completeEmployeeExit,
  createHrExitAlert,
};
