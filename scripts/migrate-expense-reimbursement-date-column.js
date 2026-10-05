const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE expense_request_details ADD COLUMN IF NOT EXISTS reimbursement_date DATE;

UPDATE expense_request_details
SET reimbursement_date = (reimbursement_month || '-01')::date
WHERE reimbursement_date IS NULL
  AND reimbursement_month IS NOT NULL
  AND reimbursement_month ~ '^\\d{4}-\\d{2}$';
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: expense_request_details reimbursement_date column ready');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
