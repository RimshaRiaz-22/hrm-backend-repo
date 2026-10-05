const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE employee_pf_balances ADD COLUMN IF NOT EXISTS is_enrolled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employee_pf_balances ADD COLUMN IF NOT EXISTS employee_contribution_rate NUMERIC(5, 2) NOT NULL DEFAULT 8.33;
ALTER TABLE employee_pf_balances ADD COLUMN IF NOT EXISTS employer_contribution_rate NUMERIC(5, 2) NOT NULL DEFAULT 8.33;
ALTER TABLE employee_pf_balances ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMP;
ALTER TABLE employee_pf_balances ADD COLUMN IF NOT EXISTS enrolled_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

UPDATE employee_pf_balances
SET is_enrolled = TRUE,
    enrolled_at = COALESCE(enrolled_at, created_at)
WHERE is_enrolled = FALSE;

CREATE INDEX IF NOT EXISTS employee_pf_balances_enrolled_idx
  ON employee_pf_balances(company_id, is_enrolled);

CREATE TABLE IF NOT EXISTS employee_pf_contribution_periods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month VARCHAR(7) NOT NULL,
  employee_amount NUMERIC(14, 2) NOT NULL CHECK (employee_amount >= 0),
  employer_amount NUMERIC(14, 2) NOT NULL CHECK (employer_amount >= 0),
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount > 0),
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, period_month)
);

CREATE INDEX IF NOT EXISTS employee_pf_contribution_periods_company_idx
  ON employee_pf_contribution_periods(company_id, period_month);
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: PF enrollment and contribution periods');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
