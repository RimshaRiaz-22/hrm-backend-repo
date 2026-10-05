const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS manager_comment TEXT;

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;

ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN ('pending', 'manager_approved', 'approved', 'rejected', 'cancelled'));
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: leave_requests supports manager_approved status and manager_comment');
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
