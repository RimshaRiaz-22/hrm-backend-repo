const pool = require('./index');

const EMPLOYEE_ONBOARDING_MODULE_SQL = `
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS onboarding_submitted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS onboarding_activated_at TIMESTAMP;

COMMENT ON COLUMN employees.onboarding_status IS
  'Invite-to-activation lifecycle (pending_invite/pre_boarding/active). Independent of employment_status (resignation lifecycle).';

ALTER TABLE document_types
  ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS onboarding_documents (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type_id BIGINT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  file_url TEXT,
  file_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  skip_reason TEXT,
  rejection_reason TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT onboarding_documents_employee_type_unique UNIQUE (employee_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS onboarding_documents_employee_id_idx ON onboarding_documents(employee_id);
CREATE INDEX IF NOT EXISTS onboarding_documents_company_id_idx ON onboarding_documents(company_id);
`;

async function ensureEmployeeOnboardingModuleSchema() {
  await pool.query(EMPLOYEE_ONBOARDING_MODULE_SQL);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'employees_onboarding_status_check'
      ) THEN
        ALTER TABLE employees
          ADD CONSTRAINT employees_onboarding_status_check
          CHECK (onboarding_status IN ('pending_invite', 'pre_boarding', 'active'));
      END IF;
    END
    $$;
  `);
}

module.exports = {
  ensureEmployeeOnboardingModuleSchema,
};
