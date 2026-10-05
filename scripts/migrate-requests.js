const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
-- Day 1: requests (master table — used by all request phases)
CREATE TABLE IF NOT EXISTS requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_type VARCHAR(40) NOT NULL CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document', 'loan', 'expense'
    )
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'cancelled')
  ),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  hr_comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS requests_company_status_type_idx
  ON requests(company_id, status, request_type);
CREATE INDEX IF NOT EXISTS requests_employee_status_idx
  ON requests(employee_id, status);

-- Day 2: attendance_correction_details (detail table for Phase 1)
CREATE TABLE IF NOT EXISTS attendance_correction_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  correction_date DATE NOT NULL,
  original_check_in TIMESTAMP,
  original_check_out TIMESTAMP,
  corrected_check_in TIMESTAMP NOT NULL,
  corrected_check_out TIMESTAMP NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS attendance_correction_details_date_idx
  ON attendance_correction_details(correction_date);
`;

async function main() {
  await pool.query(sql);

  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('requests', 'attendance_correction_details')
     ORDER BY table_name`
  );

  const requestsCols = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'requests'
     ORDER BY ordinal_position`
  );

  const detailsCols = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'attendance_correction_details'
     ORDER BY ordinal_position`
  );

  console.log('Migration OK: Phase 1 request tables ready');
  // console.log('Tables:', tables.rows.map((r) => r.table_name).join(', '));
  console.log('\nrequests columns:');
  // requestsCols.rows.forEach((r) => {
  //   console.log(`  - ${r.column_name} (${r.data_type}, nullable=${r.is_nullable})`);
  // });
  // console.log('\nattendance_correction_details columns:');
  // detailsCols.rows.forEach((r) => {
  //   console.log(`  - ${r.column_name} (${r.data_type}, nullable=${r.is_nullable})`);
  // });

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
