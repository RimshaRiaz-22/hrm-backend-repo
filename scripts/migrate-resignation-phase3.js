const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
-- Employee lifecycle fields for resignation / exit
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_status VARCHAR(30) NOT NULL DEFAULT 'active';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_working_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS exit_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS final_settlement_pending BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_employment_status_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_employment_status_check
      CHECK (employment_status IN ('active', 'serving_notice', 'exited'));
  END IF;
END
$$;

-- Notice period days from employee contract (default 30)
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS notice_period_days INTEGER NOT NULL DEFAULT 30;

-- Extend review_stage to support CEO step for resignation
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_review_stage_check;
ALTER TABLE requests ADD CONSTRAINT requests_review_stage_check
  CHECK (review_stage IS NULL OR review_stage IN ('manager', 'hr', 'ceo'));

CREATE TABLE IF NOT EXISTS resignation_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  last_intended_date DATE NOT NULL,
  reason TEXT,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  calculated_last_working_date DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS resignation_details_request_idx
  ON resignation_details(request_id);

CREATE TABLE IF NOT EXISTS notice_periods (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  notice_start_date DATE NOT NULL,
  notice_end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'serving'
    CHECK (status IN ('serving', 'completed', 'waived')),
  alert_7d_sent BOOLEAN NOT NULL DEFAULT false,
  alert_final_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS notice_periods_employee_idx ON notice_periods(employee_id);
CREATE INDEX IF NOT EXISTS notice_periods_status_end_idx ON notice_periods(status, notice_end_date);

CREATE TABLE IF NOT EXISTS hr_exit_alerts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  notice_period_id BIGINT REFERENCES notice_periods(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL CHECK (alert_type IN ('7_day_warning', 'final_settlement')),
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS hr_exit_alerts_company_created_idx
  ON hr_exit_alerts(company_id, created_at DESC);
`;

async function main() {
  await pool.query(sql);

  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('resignation_details', 'notice_periods', 'hr_exit_alerts')
     ORDER BY table_name`
  );

  console.log('Migration OK: Phase 3 resignation tables ready');
  // console.log('Tables:', tables.rows.map((r) => r.table_name).join(', ') || '(none)');

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
