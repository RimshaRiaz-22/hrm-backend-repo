const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_request_type_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_request_type_check CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document',
      'loan', 'advance', 'expense', 'pf_temporary', 'pf_permanent'
    )
  );

CREATE TABLE IF NOT EXISTS pf_permanent_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  withdrawal_date DATE NOT NULL,
  purpose TEXT NOT NULL,
  payout_method VARCHAR(20) CHECK (payout_method IS NULL OR payout_method IN ('payroll', 'direct', 'off_cycle')),
  pf_balance_before NUMERIC(14, 2),
  payout_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (payout_status IN ('pending', 'payable', 'paid')),
  payable_at TIMESTAMP,
  paid_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pf_permanent_request_details_request_idx
  ON pf_permanent_request_details(request_id);
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: pf_permanent tables and request type');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
