const pool = require('../db');
const { HR_REQUEST_ROLES } = require('./requests.service');
const { daysBetween } = require('./resignationRequest.service');
const { toDateKey, todayDateKeyInTimezone, wallClockMinutesInTimezone } = require('../utils/dateTime');
const emailService = require('./email.service');
const pushNotificationService = require('./pushNotification.service');

const REMINDER_OFFSETS = [3, 2, 0];
const DEFAULT_TIMEZONE = 'UTC';
/** Companies are "due" while their local wall clock is within this many minutes past local midnight. */
const SEND_WINDOW_MINUTES = 15;

function resolveTimezone(timezone) {
  return String(timezone || '').trim() || DEFAULT_TIMEZONE;
}

/** True once per day, per timezone, for the ~15-minute window right after local midnight. */
function isTimezoneDueNow(timezone, now = new Date()) {
  const minutes = wallClockMinutesInTimezone(now, resolveTimezone(timezone));
  return minutes !== null && minutes >= 0 && minutes < SEND_WINDOW_MINUTES;
}

function getNextAnniversaryOccurrence(joiningDateKey, todayKey) {
  if (!joiningDateKey || !todayKey) return null;
  const [, month, day] = joiningDateKey.split('-');
  const [year] = todayKey.split('-');
  let occurrence = `${year}-${month}-${day}`;
  if (occurrence < todayKey) {
    occurrence = `${Number(year) + 1}-${month}-${day}`;
  }
  return occurrence;
}

function formatDisplayDate(dateKey) {
  if (!dateKey) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function formatYearsLabel(years) {
  if (!(years > 0)) return null;
  return years === 1 ? '1 year' : `${years} years`;
}

/** Returns true when this (employee, event, recipient) combo has not been notified yet. */
async function claimNotification({ employeeId, eventDate, daysUntil, recipientType, recipientUserId }) {
  const result = await pool.query(
    `INSERT INTO anniversary_notification_log (employee_id, event_date, days_until, recipient_type, recipient_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id, event_date, recipient_type, recipient_user_id, days_until) DO NOTHING
     RETURNING id`,
    [employeeId, eventDate, daysUntil, recipientType, recipientUserId]
  );
  return result.rowCount > 0;
}

async function getCompanyHrRecipients(companyId, excludeEmployeeId) {
  const result = await pool.query(
    `SELECT id, email, employee_id
     FROM users
     WHERE company_id = $1 AND is_active = true AND role = ANY($2::text[])`,
    [companyId, Array.from(HR_REQUEST_ROLES)]
  );
  return result.rows.filter((row) => Number(row.employee_id) !== Number(excludeEmployeeId));
}

async function notifyHrForAnniversary({
  companyId,
  companyName,
  employeeId,
  employeeName,
  eventDate,
  daysUntil,
  yearsCompleted,
}) {
  const recipients = await getCompanyHrRecipients(companyId, employeeId);
  const eventDateDisplay = formatDisplayDate(eventDate);
  const yearsLabel = formatYearsLabel(yearsCompleted);

  for (const recipient of recipients) {
    const isNew = await claimNotification({
      employeeId,
      eventDate,
      daysUntil,
      recipientType: 'hr',
      recipientUserId: recipient.id,
    });
    if (!isNew) continue;

    emailService
      .sendAnniversaryReminderEmail(recipient.email, {
        employeeName,
        daysUntil,
        eventDateDisplay,
        yearsLabel,
        companyId,
        companyName,
      })
      .catch((error) => console.error('[anniversary-notification] HR email failed:', error.message));

    const yearsSuffix = yearsLabel ? ` ${yearsLabel}` : '';
    pushNotificationService
      .sendNotificationSafely({
        userId: recipient.id,
        title:
          daysUntil === 0
            ? `Today is ${employeeName}'s work anniversary!`
            : `${employeeName}'s work anniversary is coming up`,
        body:
          daysUntil === 0
            ? `Celebrate ${employeeName}'s${yearsSuffix} work anniversary today!`
            : `${employeeName}'s work anniversary is on ${eventDateDisplay} (in ${daysUntil} day${daysUntil === 1 ? '' : 's'}).`,
        data: { type: 'anniversary_reminder', employee_id: String(employeeId), days_until: String(daysUntil) },
        label: 'anniversary_reminder_hr',
      })
      .catch((error) => console.error('[anniversary-notification] HR push failed:', error.message));
  }
}

async function notifyEmployeeAnniversary({ companyId, companyName, employeeId, employeeName, eventDate, yearsCompleted }) {
  const userResult = await pool.query(
    `SELECT id, email FROM users WHERE company_id = $1 AND employee_id = $2 AND is_active = true LIMIT 1`,
    [companyId, employeeId]
  );
  const user = userResult.rows[0];
  if (!user) return;

  const isNew = await claimNotification({
    employeeId,
    eventDate,
    daysUntil: 0,
    recipientType: 'employee',
    recipientUserId: user.id,
  });
  if (!isNew) return;

  const yearsLabel = formatYearsLabel(yearsCompleted);

  emailService
    .sendWorkAnniversaryEmail(user.email, { employeeName, yearsLabel, companyId, companyName })
    .catch((error) => console.error('[anniversary-notification] employee email failed:', error.message));

  pushNotificationService
    .sendNotificationToEmployee(companyId, employeeId, {
      title: 'Happy Work Anniversary!',
      body: yearsLabel
        ? `Congratulations on ${yearsLabel} with the team, ${employeeName}!`
        : `Congratulations on your work anniversary, ${employeeName}!`,
      data: { type: 'work_anniversary', employee_id: String(employeeId) },
      label: 'work_anniversary',
    })
    .catch((error) => console.error('[anniversary-notification] employee push failed:', error.message));
}

/**
 * Active employees with a joining/hire date and their effective timezone resolved:
 * their assigned work location's timezone (from lat/long) first, falling back to
 * their company's timezone, falling back to UTC.
 */
async function getCandidateEmployees() {
  const result = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.company_id, c.name AS company_name,
            jd.joining_date, jd.hire_date,
            COALESCE(wl.timezone, c.timezone) AS effective_timezone
     FROM employees e
     JOIN companies c ON c.id = e.company_id
     LEFT JOIN employee_job_details jd ON jd.employee_id = e.id
     LEFT JOIN attendance_location_settings wl ON wl.id = jd.work_location_id
     WHERE e.employment_status != 'exited'
       AND (jd.joining_date IS NOT NULL OR jd.hire_date IS NOT NULL)`
  );
  return result.rows;
}

/** Groups employees by their resolved effective timezone string. */
function groupByTimezone(employees) {
  const groups = new Map();
  for (const row of employees) {
    const timezone = resolveTimezone(row.effective_timezone);
    if (!groups.has(timezone)) groups.set(timezone, []);
    groups.get(timezone).push(row);
  }
  return groups;
}

async function processEmployeesForTimezone(timezone, employees) {
  const todayKey = todayDateKeyInTimezone(timezone);

  for (const row of employees) {
    const joiningDateKey = toDateKey(row.joining_date) || toDateKey(row.hire_date);
    const eventDate = getNextAnniversaryOccurrence(joiningDateKey, todayKey);
    if (!eventDate) continue;

    const daysUntil = daysBetween(todayKey, eventDate);
    if (daysUntil === null || !REMINDER_OFFSETS.includes(daysUntil)) continue;

    const yearsCompleted = Number(eventDate.slice(0, 4)) - Number(joiningDateKey.slice(0, 4));
    const employeeName = `${row.first_name} ${row.last_name}`.trim();
    const employeeId = row.id;

    await notifyHrForAnniversary({
      companyId: row.company_id,
      companyName: row.company_name,
      employeeId,
      employeeName,
      eventDate,
      daysUntil,
      yearsCompleted,
    });

    if (daysUntil === 0) {
      await notifyEmployeeAnniversary({
        companyId: row.company_id,
        companyName: row.company_name,
        employeeId,
        employeeName,
        eventDate,
        yearsCompleted,
      });
    }
  }
}

/** Call frequently (e.g. every 15 min) — only timezones at local midnight right now get processed. */
async function processDueAnniversaryNotifications() {
  const now = new Date();
  const employees = await getCandidateEmployees();
  const groups = groupByTimezone(employees);

  for (const [timezone, group] of groups) {
    if (!isTimezoneDueNow(timezone, now)) continue;
    await processEmployeesForTimezone(timezone, group);
  }
}

module.exports = {
  processDueAnniversaryNotifications,
  processEmployeesForTimezone,
};
