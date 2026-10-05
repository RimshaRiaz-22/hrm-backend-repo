const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS manager_reviewed_by BIGINT REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMP;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hr_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hr_reviewed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS leave_requests_manager_reviewed_by_idx
  ON leave_requests(manager_reviewed_by);

CREATE INDEX IF NOT EXISTS leave_requests_hr_reviewed_by_idx
  ON leave_requests(hr_reviewed_by);
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: leave_requests reviewer tracking columns added');
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
