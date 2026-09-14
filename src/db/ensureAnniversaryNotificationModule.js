const pool = require('./index');

const ANNIVERSARY_NOTIFICATION_MODULE_SQL = `
CREATE TABLE IF NOT EXISTS anniversary_notification_log (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  days_until INTEGER NOT NULL,
  recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('employee', 'hr')),
  recipient_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (employee_id, event_date, recipient_type, recipient_user_id, days_until)
);

CREATE INDEX IF NOT EXISTS anniversary_notification_log_employee_idx ON anniversary_notification_log(employee_id, event_date);
`;

async function ensureAnniversaryNotificationModuleSchema() {
  await pool.query(ANNIVERSARY_NOTIFICATION_MODULE_SQL);
}

module.exports = {
  ensureAnniversaryNotificationModuleSchema,
};
