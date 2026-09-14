const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE expense_request_details ADD COLUMN IF NOT EXISTS payable_at TIMESTAMP;
ALTER TABLE expense_request_details ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;

UPDATE expense_request_details erd
SET payable_at = r.reviewed_at
FROM requests r
WHERE r.id = erd.request_id
  AND erd.reimbursement_status IN ('payable', 'paid')
  AND erd.payable_at IS NULL
  AND r.reviewed_at IS NOT NULL;
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: expense_request_details payable_at and paid_at columns ready');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
