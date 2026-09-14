const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE notice_periods ADD COLUMN IF NOT EXISTS waive_reason TEXT;
ALTER TABLE notice_periods ADD COLUMN IF NOT EXISTS waived_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notice_periods ADD COLUMN IF NOT EXISTS waived_at TIMESTAMP;
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: notice period waive columns ready');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
