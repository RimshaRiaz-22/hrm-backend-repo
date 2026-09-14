const pool = require('./index');
const { resolveTimezoneFromCoordinates } = require('../utils/coordinatesTimezone');

const BIRTHDAY_NOTIFICATION_MODULE_SQL = `
CREATE TABLE IF NOT EXISTS birthday_notification_log (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  days_until INTEGER NOT NULL,
  recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('employee', 'hr')),
  recipient_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (employee_id, event_date, recipient_type, recipient_user_id, days_until)
);

CREATE INDEX IF NOT EXISTS birthday_notification_log_employee_idx ON birthday_notification_log(employee_id, event_date);

ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(80);
`;

/** One-time catch-up for work locations that had lat/long before the timezone column existed. */
async function backfillWorkLocationTimezones() {
  const result = await pool.query(
    `SELECT id, latitude, longitude
     FROM attendance_location_settings
     WHERE timezone IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL`
  );

  for (const row of result.rows) {
    const timezone = resolveTimezoneFromCoordinates(row.latitude, row.longitude);
    if (!timezone) continue;
    await pool.query('UPDATE attendance_location_settings SET timezone = $1 WHERE id = $2', [
      timezone,
      row.id,
    ]);
  }

  return result.rows.length;
}

async function ensureBirthdayNotificationModuleSchema() {
  await pool.query(BIRTHDAY_NOTIFICATION_MODULE_SQL);
  await backfillWorkLocationTimezones();
}

module.exports = {
  ensureBirthdayNotificationModuleSchema,
};
