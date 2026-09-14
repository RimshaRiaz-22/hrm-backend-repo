const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_request_type_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_request_type_check CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document', 'loan', 'advance', 'expense'
    )
  );
`;

async function main() {
  await pool.query(sql);

  const result = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'requests_request_type_check'`
  );


  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
