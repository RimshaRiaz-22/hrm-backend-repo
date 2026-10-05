const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
CREATE TABLE IF NOT EXISTS wfh_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  wfh_date DATE NOT NULL,
  reason TEXT NOT NULL,
  work_plan TEXT NOT NULL,
  UNIQUE (request_id, wfh_date)
);

CREATE INDEX IF NOT EXISTS wfh_request_details_date_idx
  ON wfh_request_details(wfh_date);
CREATE INDEX IF NOT EXISTS wfh_request_details_request_idx
  ON wfh_request_details(request_id);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS review_stage VARCHAR(20)
  CHECK (review_stage IS NULL OR review_stage IN ('manager', 'hr'));
ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_reviewed_by BIGINT
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMP;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_wfh_days_per_month INTEGER NOT NULL DEFAULT 8;
`;

async function main() {
  await pool.query(sql);

  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('wfh_request_details')
     ORDER BY table_name`
  );

  const wfhCols = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'wfh_request_details'
     ORDER BY ordinal_position`
  );

  const requestCols = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'requests'
       AND column_name IN ('review_stage', 'manager_reviewed_by', 'manager_reviewed_at')
     ORDER BY column_name`
  );

  const companyCols = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'companies'
       AND column_name = 'max_wfh_days_per_month'`
  );

  console.log('Migration OK: Phase 2 WFH request tables ready');
  // console.log('Tables:', tables.rows.map((r) => r.table_name).join(', ') || '(none)');
  console.log('\nwfh_request_details columns:');
  // wfhCols.rows.forEach((r) => {
  //   console.log(`  - ${r.column_name} (${r.data_type}, nullable=${r.is_nullable})`);
  // });
  // console.log('\nrequests phase-2 columns:', requestCols.rows.map((r) => r.column_name).join(', '));
  // console.log('companies.max_wfh_days_per_month:', companyCols.rows.length ? 'present' : 'missing');

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
