const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { toDateKey, todayDateKeyInTimezone } = require('../utils/dateTime');
const { HR_REQUEST_ROLES } = require('./requests.service');
const { daysBetween } = require('./resignationRequest.service');

const REMINDER_OFFSETS = [3, 2, 0];
const ESS_ROLES = new Set([USER_ROLES.EMPLOYEE, USER_ROLES.DEPARTMENT_MANAGER]);
const DEFAULT_TIMEZONE = 'UTC';

/** Employee's own timezone: assigned work location's (from lat/long) first, then company's, then UTC. */
function resolveEmployeeTimezone(row) {
  return String(row.effective_timezone || '').trim() || DEFAULT_TIMEZONE;
}

const ALERT_TYPES = {
  BIRTHDAY: 'birthday',
  CNIC_EXPIRY: 'cnic_expiry',
  ANNIVERSARY: 'anniversary',
};

async function getReminderViewerContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, employee_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };

  const isHrReviewer = HR_REQUEST_ROLES.has(user.role);
  const isSelfServiceRole =
    user.role === USER_ROLES.EMPLOYEE || user.role === USER_ROLES.DEPARTMENT_MANAGER;

  if (isSelfServiceRole && user.company_id && user.employee_id) {
    return {
      user,
      scope: 'self',
      employeeId: Number(user.employee_id),
      companyId: Number(user.company_id),
    };
  }

  if (isHrReviewer) {
    if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
      return { error: 'Your account must be linked to a company.' };
    }
    return { user, scope: 'company' };
  }

  return { error: 'You do not have permission to view employee reminders.' };
}

function formatDisplayDate(dateKey) {
  if (!dateKey) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function getNextAnnualOccurrence(sourceDateKey, todayKey) {
  if (!sourceDateKey || !todayKey) return null;
  const [, month, day] = sourceDateKey.split('-');
  const [year] = todayKey.split('-');
  let occurrence = `${year}-${month}-${day}`;
  if (occurrence < todayKey) {
    occurrence = `${Number(year) + 1}-${month}-${day}`;
  }
  return occurrence;
}

function buildReminderMessage({ alertType, employeeName, eventDateKey, daysUntil, perspective = 'hr' }) {
  const dateLabel = formatDisplayDate(eventDateKey);
  const isSelf = perspective === 'self';

  if (alertType === ALERT_TYPES.BIRTHDAY) {
    if (daysUntil === 0) return isSelf ? 'Today is your birthday!' : `Today is ${employeeName}'s birthday.`;
    if (daysUntil === 2) {
      return isSelf
        ? `Your birthday is in 2 days (${dateLabel}).`
        : `${employeeName}'s birthday is in 2 days (${dateLabel}).`;
    }
    return isSelf
      ? `Your birthday is in 3 days (${dateLabel}).`
      : `${employeeName}'s birthday is in 3 days (${dateLabel}).`;
  }

  if (alertType === ALERT_TYPES.CNIC_EXPIRY) {
    if (daysUntil === 0) {
      return isSelf
        ? `Your CNIC expires today (${dateLabel}).`
        : `${employeeName}'s CNIC expires today (${dateLabel}).`;
    }
    if (daysUntil === 2) {
      return isSelf
        ? `Your CNIC expires in 2 days (${dateLabel}).`
        : `${employeeName}'s CNIC expires in 2 days (${dateLabel}).`;
    }
    return isSelf
      ? `Your CNIC expires in 3 days (${dateLabel}).`
      : `${employeeName}'s CNIC expires in 3 days (${dateLabel}).`;
  }

  if (daysUntil === 0) {
    return isSelf ? 'Today is your work anniversary.' : `Today is ${employeeName}'s work anniversary.`;
  }
  if (daysUntil === 2) {
    return isSelf
      ? `Your work anniversary is in 2 days (${dateLabel}).`
      : `${employeeName}'s work anniversary is in 2 days (${dateLabel}).`;
  }
  return isSelf
    ? `Your work anniversary is in 3 days (${dateLabel}).`
    : `${employeeName}'s work anniversary is in 3 days (${dateLabel}).`;
}

function buildReminder({
  alertType,
  employeeId,
  employeeName,
  employeeEmail,
  sourceDateKey,
  todayKey,
  recurring = false,
  perspective = 'hr',
}) {
  if (!sourceDateKey) return null;

  const eventDateKey = recurring
    ? getNextAnnualOccurrence(sourceDateKey, todayKey)
    : sourceDateKey;
  if (!eventDateKey) return null;

  const daysUntil = daysBetween(todayKey, eventDateKey);
  if (daysUntil === null || !REMINDER_OFFSETS.includes(daysUntil)) return null;
  if (!recurring && daysUntil < 0) return null;

  const yearsCompleted =
    recurring && alertType === ALERT_TYPES.ANNIVERSARY
      ? Number(eventDateKey.slice(0, 4)) - Number(sourceDateKey.slice(0, 4))
      : null;

  return {
    id: `${alertType}-${employeeId}-${eventDateKey}-${daysUntil}`,
    alert_type: alertType,
    employee_id: Number(employeeId),
    employee_name: employeeName,
    employee_email: employeeEmail || null,
    event_date: eventDateKey,
    days_until: daysUntil,
    years_completed: yearsCompleted != null && yearsCompleted > 0 ? yearsCompleted : null,
    message: buildReminderMessage({ alertType, employeeName, eventDateKey, daysUntil, perspective }),
    banner_type: daysUntil === 0 ? 'warning' : 'info',
    is_self: perspective === 'self',
  };
}

function remindersForEmployee(row, todayKey, { perspective = 'hr' } = {}) {
  const employeeName = `${row.first_name} ${row.last_name}`.trim();
  const employeeEmail = row.work_email || null;
  const employeeId = row.id;
  const reminders = [];

  const birthdayReminder = buildReminder({
    alertType: ALERT_TYPES.BIRTHDAY,
    employeeId,
    employeeName,
    employeeEmail,
    sourceDateKey: toDateKey(row.dob),
    todayKey,
    recurring: true,
    perspective,
  });
  if (birthdayReminder) reminders.push(birthdayReminder);

  const cnicReminder = buildReminder({
    alertType: ALERT_TYPES.CNIC_EXPIRY,
    employeeId,
    employeeName,
    employeeEmail,
    sourceDateKey: toDateKey(row.national_id_expiry),
    todayKey,
    recurring: false,
    perspective,
  });
  if (cnicReminder) reminders.push(cnicReminder);

  const joiningDate = toDateKey(row.joining_date) || toDateKey(row.hire_date);
  const anniversaryReminder = buildReminder({
    alertType: ALERT_TYPES.ANNIVERSARY,
    employeeId,
    employeeName,
    employeeEmail,
    sourceDateKey: joiningDate,
    todayKey,
    recurring: true,
    perspective,
  });
  if (anniversaryReminder) {
    if (anniversaryReminder.years_completed != null && anniversaryReminder.years_completed > 0) {
      const yearsLabel =
        anniversaryReminder.years_completed === 1
          ? '1 year'
          : `${anniversaryReminder.years_completed} years`;
      if (perspective === 'self') {
        if (anniversaryReminder.days_until === 0) {
          anniversaryReminder.message = `Today is your ${yearsLabel} work anniversary.`;
        } else if (anniversaryReminder.days_until === 2) {
          anniversaryReminder.message = `Your ${yearsLabel} work anniversary is in 2 days (${formatDisplayDate(anniversaryReminder.event_date)}).`;
        } else {
          anniversaryReminder.message = `Your ${yearsLabel} work anniversary is in 3 days (${formatDisplayDate(anniversaryReminder.event_date)}).`;
        }
      } else if (anniversaryReminder.days_until === 0) {
        anniversaryReminder.message = `Today is ${employeeName}'s ${yearsLabel} work anniversary.`;
      } else if (anniversaryReminder.days_until === 2) {
        anniversaryReminder.message = `${employeeName}'s ${yearsLabel} work anniversary is in 2 days (${formatDisplayDate(anniversaryReminder.event_date)}).`;
      } else {
        anniversaryReminder.message = `${employeeName}'s ${yearsLabel} work anniversary is in 3 days (${formatDisplayDate(anniversaryReminder.event_date)}).`;
      }
    }
    reminders.push(anniversaryReminder);
  }

  return reminders;
}

async function listEmployeeReminders(auth, query = {}) {
  const viewer = await getReminderViewerContext(auth);
  if (viewer.error) {
    return { error: viewer.error, status: 403 };
  }

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const perspective = viewer.scope === 'self' ? 'self' : 'hr';
  const conditions = ["e.employment_status != 'exited'"];
  const params = [];

  if (viewer.scope === 'self') {
    params.push(viewer.employeeId);
    conditions.push(`e.id = $${params.length}`);
    params.push(viewer.companyId);
    conditions.push(`e.company_id = $${params.length}`);
  } else if (viewer.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(viewer.user.company_id);
    conditions.push(`e.company_id = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.dob,
            e.national_id_expiry,
            jd.joining_date,
            jd.hire_date,
            COALESCE(wl.timezone, c.timezone) AS effective_timezone
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     LEFT JOIN employee_job_details jd ON jd.employee_id = e.id
     LEFT JOIN attendance_location_settings wl ON wl.id = jd.work_location_id
     ${whereClause}
     ORDER BY e.first_name, e.last_name`,
    params
  );

  const items = result.rows
    .flatMap((row) =>
      remindersForEmployee(row, todayDateKeyInTimezone(resolveEmployeeTimezone(row)), { perspective })
    )
    .sort((a, b) => {
      if (a.days_until !== b.days_until) return a.days_until - b.days_until;
      return a.employee_name.localeCompare(b.employee_name);
    })
    .slice(0, limit);

  return { data: { items } };
}

module.exports = {
  listEmployeeReminders,
  ALERT_TYPES,
};
