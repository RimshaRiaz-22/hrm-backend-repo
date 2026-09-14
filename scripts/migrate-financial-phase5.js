const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
CREATE TABLE IF NOT EXISTS loan_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  tenure_months INTEGER CHECK (tenure_months IS NULL OR tenure_months > 0),
  emi_amount NUMERIC(14, 2),
  repayment_type VARCHAR(20) NOT NULL CHECK (repayment_type IN ('installment', 'one_time')),
  purpose TEXT NOT NULL,
  repayment_start VARCHAR(10)
);

CREATE INDEX IF NOT EXISTS loan_request_details_request_idx
  ON loan_request_details(request_id);

CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  tenure_months INTEGER CHECK (tenure_months IS NULL OR tenure_months > 0),
  emi_amount NUMERIC(14, 2),
  repayment_type VARCHAR(20) NOT NULL CHECK (repayment_type IN ('installment', 'one_time')),
  outstanding_balance NUMERIC(14, 2) NOT NULL CHECK (outstanding_balance >= 0),
  start_month VARCHAR(7),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS loans_employee_status_idx
  ON loans(employee_id, status);
CREATE INDEX IF NOT EXISTS loans_company_idx
  ON loans(company_id);

CREATE TABLE IF NOT EXISTS loan_payments (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS loan_payments_loan_idx
  ON loan_payments(loan_id);

CREATE TABLE IF NOT EXISTS expense_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  category VARCHAR(20) NOT NULL CHECK (category IN ('travel', 'meals', 'office', 'client', 'others')),
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount > 0),
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  reimbursement_month VARCHAR(7),
  reimbursement_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (reimbursement_status IN ('pending', 'payable', 'paid'))
);

CREATE INDEX IF NOT EXISTS expense_request_details_request_idx
  ON expense_request_details(request_id);
`;

async function main() {
  await pool.query(sql);

  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'loan_request_details', 'loans', 'loan_payments', 'expense_request_details'
       )
     ORDER BY table_name`
  );

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
