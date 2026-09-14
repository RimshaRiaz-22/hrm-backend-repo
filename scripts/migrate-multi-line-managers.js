const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE department_line_managers
  ADD COLUMN IF NOT EXISTS manager_role VARCHAR(20) NOT NULL DEFAULT 'additional';

ALTER TABLE department_line_managers DROP CONSTRAINT IF EXISTS department_line_managers_role_check;
ALTER TABLE department_line_managers
  ADD CONSTRAINT department_line_managers_role_check
  CHECK (manager_role IN ('primary', 'additional'));

CREATE TABLE IF NOT EXISTS employee_line_managers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_role VARCHAR(20) NOT NULL CHECK (manager_role IN ('primary', 'additional')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT employee_line_managers_employee_manager_unique UNIQUE (employee_id, manager_id)
);

CREATE INDEX IF NOT EXISTS employee_line_managers_company_id_idx
  ON employee_line_managers(company_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_employee_id_idx
  ON employee_line_managers(employee_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_manager_id_idx
  ON employee_line_managers(manager_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_company_manager_idx
  ON employee_line_managers(company_id, manager_id);

CREATE UNIQUE INDEX IF NOT EXISTS employee_line_managers_one_primary_idx
  ON employee_line_managers(employee_id)
  WHERE manager_role = 'primary';

WITH ranked AS (
  SELECT id,
         department_id,
         ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY id ASC) AS rn
  FROM department_line_managers
)
UPDATE department_line_managers dlm
SET manager_role = CASE WHEN ranked.rn = 1 THEN 'primary' ELSE 'additional' END
FROM ranked
WHERE dlm.id = ranked.id;

INSERT INTO employee_line_managers (company_id, employee_id, manager_id, manager_role, created_at, updated_at)
SELECT ejd.company_id, ejd.employee_id, ejd.line_manager_id, 'primary', NOW(), NOW()
FROM employee_job_details ejd
WHERE ejd.line_manager_id IS NOT NULL
ON CONFLICT (employee_id, manager_id) DO NOTHING;
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: multi line manager roles and employee_line_managers table');
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
