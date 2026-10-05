const pool = require('./index');

/**
 * Additive leave anniversary-cycle schema.
 * Existing calendar-year leave_balances rows stay valid (period_* NULL).
 */
const LEAVE_CYCLE_SQL = `
ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS period_start DATE;

ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS period_end DATE;

ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS renewal_date DATE;

ALTER TABLE leave_balances
  ADD COLUMN IF NOT EXISTS cycle_status VARCHAR(20);

UPDATE leave_balances
SET cycle_status = 'active'
WHERE cycle_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_balances_cycle_status_check'
  ) THEN
    ALTER TABLE leave_balances
      ADD CONSTRAINT leave_balances_cycle_status_check
      CHECK (cycle_status IS NULL OR cycle_status IN ('active', 'expired'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS leave_balances_employee_policy_period_unique
  ON leave_balances (employee_id, leave_policy_id, period_start)
  WHERE period_start IS NOT NULL;

CREATE INDEX IF NOT EXISTS leave_balances_renewal_date_idx
  ON leave_balances (renewal_date)
  WHERE cycle_status = 'active' AND period_start IS NOT NULL;

CREATE INDEX IF NOT EXISTS leave_balances_cycle_status_idx
  ON leave_balances (company_id, cycle_status);

CREATE TABLE IF NOT EXISTS leave_policy_cycle_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  leave_balance_id BIGINT REFERENCES leave_balances(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  renewal_date DATE NOT NULL,
  total_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  used_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  available_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  closed_reason VARCHAR(40) NOT NULL DEFAULT 'renewed'
    CHECK (closed_reason IN ('renewed', 'joining_date_changed', 'policy_inactive', 'manual')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_policy_cycle_history_period_unique
    UNIQUE (employee_id, leave_policy_id, period_start)
);

CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_company_id_idx
  ON leave_policy_cycle_history(company_id);
CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_employee_id_idx
  ON leave_policy_cycle_history(employee_id);
CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_policy_id_idx
  ON leave_policy_cycle_history(leave_policy_id);
CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_company_created_idx
  ON leave_policy_cycle_history(company_id, created_at DESC);
`;

async function ensureLeaveCycleModuleSchema() {
  await pool.query(LEAVE_CYCLE_SQL);
}

module.exports = {
  ensureLeaveCycleModuleSchema,
};
