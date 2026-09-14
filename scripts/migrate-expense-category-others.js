const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE expense_request_details
  DROP CONSTRAINT IF EXISTS expense_request_details_category_check;

ALTER TABLE expense_request_details
  ADD CONSTRAINT expense_request_details_category_check
  CHECK (category IN ('travel', 'meals', 'office', 'client', 'others'));
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: expense category "others" is allowed');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
