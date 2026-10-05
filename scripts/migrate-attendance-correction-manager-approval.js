const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_comment TEXT;

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_status_check
  CHECK (status IN ('pending', 'manager_approved', 'approved', 'rejected', 'cancelled'));

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_manager_approved_scope_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_manager_approved_scope_check
  CHECK (status != 'manager_approved' OR request_type = 'attendance_correction');

CREATE INDEX IF NOT EXISTS requests_manager_reviewed_by_idx ON requests(manager_reviewed_by);
`;

// manager_reviewed_by was originally scaffolded as REFERENCES users(id), but the
// manager who reviews a request is identified by employees.id (via employee_line_managers),
// same as leave_requests.manager_reviewed_by. The column has always been NULL in
// production, so repointing its FK is safe. Constraint name is looked up dynamically
// instead of assumed, since it may not match Postgres's default auto-generated name.
const repointForeignKeySql = `
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT tc.constraint_name INTO con_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'requests'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'manager_reviewed_by';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE requests DROP CONSTRAINT %I', con_name);
  END IF;
END
$$;

ALTER TABLE requests
  ADD CONSTRAINT requests_manager_reviewed_by_fkey
  FOREIGN KEY (manager_reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
`;

async function main() {
  const existingNonNull = await pool.query(
    `SELECT COUNT(*)::int AS count FROM requests WHERE manager_reviewed_by IS NOT NULL`
  );
  if (existingNonNull.rows[0].count > 0) {
    throw new Error(
      `Refusing to repoint requests.manager_reviewed_by FK: ${existingNonNull.rows[0].count} row(s) already have a non-null value. Investigate before proceeding.`
    );
  }

  await pool.query(sql);
  await pool.query(repointForeignKeySql);
  console.log(
    'Migration OK: requests supports manager_approved status (attendance_correction only), manager_comment, and manager_reviewed_by now references employees(id)'
  );
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
