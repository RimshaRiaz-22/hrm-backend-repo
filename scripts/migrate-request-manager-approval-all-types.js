const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_manager_approved_scope_check;
`;

async function main() {
  await pool.query(sql);
  console.log(
    'Migration OK: manager_approved status is now allowed for all request types (same as leave flow).'
  );
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
