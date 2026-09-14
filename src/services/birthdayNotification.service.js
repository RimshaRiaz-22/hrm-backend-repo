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

function getNextBirthdayOccurrence(dobKey, todayKey) {
  if (!dobKey || !todayKey) return null;
  const [, month, day] = dobKey.split('-');
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

/** Returns true when this (employee, event, recipient) combo has not been notified yet. */
async function claimNotification({ employeeId, eventDate, daysUntil, recipientType, recipientUserId }) {
  const result = await pool.query(
    `INSERT INTO birthday_notification_log (employee_id, event_date, days_until, recipient_type, recipient_user_id)
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

async function notifyHrForBirthday({ companyId, companyName, employeeId, employeeName, eventDate, daysUntil }) {
  const recipients = await getCompanyHrRecipients(companyId, employeeId);
  const eventDateDisplay = formatDisplayDate(eventDate);

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
      .sendBirthdayReminderEmail(recipient.email, {
        employeeName,
        daysUntil,
        eventDateDisplay,
        companyId,
        companyName,
      })
      .catch((error) => console.error('[birthday-notification] HR email failed:', error.message));

    pushNotificationService
      .sendNotificationSafely({
        userId: recipient.id,
        title: daysUntil === 0 ? `Today is ${employeeName}'s birthday!` : `${employeeName}'s birthday is coming up`,
        body:
          daysUntil === 0
            ? `Wish ${employeeName} a happy birthday today!`
            : `${employeeName}'s birthday is on ${eventDateDisplay} (in ${daysUntil} day${daysUntil === 1 ? '' : 's'}).`,
        data: { type: 'birthday_reminder', employee_id: String(employeeId), days_until: String(daysUntil) },
        label: 'birthday_reminder_hr',
      })
      .catch((error) => console.error('[birthday-notification] HR push failed:', error.message));
  }
}

async function notifyEmployeeBirthday({ companyId, companyName, employeeId, employeeName, eventDate }) {
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

  emailService
    .sendHappyBirthdayEmail(user.email, { employeeName, companyId, companyName })
    .catch((error) => console.error('[birthday-notification] employee email failed:', error.message));

  pushNotificationService
    .sendNotificationToEmployee(companyId, employeeId, {
      title: 'Happy Birthday!',
      body: `Wishing you a fantastic birthday, ${employeeName}! Have a great day.`,
      data: { type: 'happy_birthday', employee_id: String(employeeId) },
      label: 'happy_birthday',
    })
    .catch((error) => console.error('[birthday-notification] employee push failed:', error.message));
}

/**
 * Active, birth-dated employees with their effective timezone resolved:
 * their assigned work location's timezone (from lat/long) first, falling back to
 * their company's timezone, falling back to UTC.
 */
async function getCandidateEmployees() {
  const result = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.dob, e.company_id, c.name AS company_name,
            COALESCE(wl.timezone, c.timezone) AS effective_timezone
     FROM employees e
     JOIN companies c ON c.id = e.company_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
     WHERE e.employment_status != 'exited' AND e.dob IS NOT NULL`
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
    const dobKey = toDateKey(row.dob);
    const eventDate = getNextBirthdayOccurrence(dobKey, todayKey);
    if (!eventDate) continue;

    const daysUntil = daysBetween(todayKey, eventDate);
    if (daysUntil === null || !REMINDER_OFFSETS.includes(daysUntil)) continue;

    const employeeName = `${row.first_name} ${row.last_name}`.trim();
    const employeeId = row.id;

    await notifyHrForBirthday({
      companyId: row.company_id,
      companyName: row.company_name,
      employeeId,
      employeeName,
      eventDate,
      daysUntil,
    });

    if (daysUntil === 0) {
      await notifyEmployeeBirthday({
        companyId: row.company_id,
        companyName: row.company_name,
        employeeId,
        employeeName,
        eventDate,
      });
    }
  }
}

/** Call frequently (e.g. every 15 min) — only timezones at local midnight right now get processed. */
async function processDueBirthdayNotifications() {
  const now = new Date();
  const employees = await getCandidateEmployees();
  const groups = groupByTimezone(employees);

  for (const [timezone, group] of groups) {
    if (!isTimezoneDueNow(timezone, now)) continue;
    await processEmployeesForTimezone(timezone, group);
  }
}

module.exports = {
  processDueBirthdayNotifications,
  processEmployeesForTimezone,
};
