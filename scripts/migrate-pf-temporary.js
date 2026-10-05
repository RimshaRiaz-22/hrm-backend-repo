const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_request_type_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_request_type_check CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document',
      'loan', 'advance', 'expense', 'pf_temporary'
    )
  );

ALTER TABLE loans ADD COLUMN IF NOT EXISTS recovery_method VARCHAR(20)
  CHECK (recovery_method IS NULL OR recovery_method IN ('salary_deduction', 'cash'));
ALTER TABLE loans ADD COLUMN IF NOT EXISTS loan_source VARCHAR(20) NOT NULL DEFAULT 'loan'
  CHECK (loan_source IN ('loan', 'advance', 'pf_temporary'));

ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS payment_source VARCHAR(20) NOT NULL DEFAULT 'manual'
  CHECK (payment_source IN ('manual', 'payroll'));

CREATE TABLE IF NOT EXISTS employee_pf_balances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  balance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_pf_balances_company_idx ON employee_pf_balances(company_id);

CREATE TABLE IF NOT EXISTS employee_pf_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('credit', 'debit', 'adjustment')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14, 2) NOT NULL CHECK (balance_after >= 0),
  reference_type VARCHAR(40),
  reference_id BIGINT,
  notes TEXT,
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_pf_ledger_employee_idx
  ON employee_pf_ledger(employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pf_temporary_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  recovery_method VARCHAR(20) NOT NULL CHECK (recovery_method IN ('salary_deduction', 'cash')),
  installment_basis VARCHAR(30) NOT NULL
    CHECK (installment_basis IN ('fixed_amount', 'percentage_of_basic')),
  installment_amount NUMERIC(14, 2),
  installment_percentage NUMERIC(5, 2),
  emi_amount NUMERIC(14, 2) NOT NULL,
  tenure_months INTEGER NOT NULL CHECK (tenure_months > 0),
  loan_taken_date DATE NOT NULL,
  repayment_start VARCHAR(10),
  purpose TEXT NOT NULL,
  pf_balance_before NUMERIC(14, 2)
);

CREATE INDEX IF NOT EXISTS pf_temporary_request_details_request_idx
  ON pf_temporary_request_details(request_id);
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: pf_temporary tables and columns');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
