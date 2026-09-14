const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE loan_request_details
  ALTER COLUMN repayment_start TYPE VARCHAR(10);
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: loan repayment_start supports full YYYY-MM-DD dates');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
