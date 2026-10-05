const pool = require('./index');
const { SYSTEM_MODULES_SEED } = require('../constants/systemModules.seed');

const TRAINING_MODULE_SQL = `
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS lms_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lms_completed_at TIMESTAMP;

COMMENT ON COLUMN employees.lms_required IS
  'Set true only at onboarding-invite activation — gates the employee portal down to the Learning tab until lms_completed_at is set.';

CREATE TABLE IF NOT EXISTS training_materials (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('video', 'pdf')),
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS training_materials_company_id_idx ON training_materials(company_id);

CREATE TABLE IF NOT EXISTS training_completions (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  training_material_id BIGINT NOT NULL REFERENCES training_materials(id) ON DELETE CASCADE,
  completed_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT training_completions_employee_material_unique UNIQUE (employee_id, training_material_id)
);

CREATE INDEX IF NOT EXISTS training_completions_employee_id_idx ON training_completions(employee_id);
`;

// (module_key, role name) -> permission flags, matching the defaults baked into
// ACCESS_ROLE_TEMPLATES (src/constants/accessRoleTemplates.js) for the two new module keys.
// Needed because seedCompanyDefaultRoles only runs at company creation — existing companies'
// system-template roles never pick up newly-added module keys on their own, and without this
// backfill HR/Employee logins would 403 on the new Training/Learning endpoints.
const ROLE_PERMISSION_BACKFILL = [
  { role: 'Company Admin', moduleKey: 'training', view: true, add: true, edit: true, del: true },
  { role: 'Company Admin', moduleKey: 'employee_training', view: true, add: true, edit: true, del: true },
  { role: 'HR Manager', moduleKey: 'training', view: true, add: true, edit: true, del: false },
  { role: 'HR Manager', moduleKey: 'employee_training', view: true, add: true, edit: true, del: false },
  { role: 'Employee', moduleKey: 'employee_training', view: true, add: true, edit: false, del: false },
];

async function ensureTrainingModuleSchema() {
  await pool.query(TRAINING_MODULE_SQL);

  // Keep the system_modules catalog (FK target for access_role_permissions.module_key) in sync
  // with the two new keys — same upsert scripts/sync-system-modules.js performs for the full seed.
  const trainingModules = SYSTEM_MODULES_SEED.filter((m) => m.module_key === 'training' || m.module_key === 'employee_training');
  for (const mod of trainingModules) {
    await pool.query(
      `INSERT INTO system_modules (module_key, label, category, sort_order, is_active, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP)
       ON CONFLICT (module_key) DO UPDATE SET
         label = EXCLUDED.label,
         category = EXCLUDED.category,
         sort_order = EXCLUDED.sort_order,
         is_active = TRUE,
         updated_at = CURRENT_TIMESTAMP`,
      [mod.module_key, mod.label, mod.category, mod.sort_order]
    );
  }

  // Additive only (ON CONFLICT DO NOTHING) — never overwrites permissions a Company Admin
  // already customized for existing system-template roles.
  for (const grant of ROLE_PERMISSION_BACKFILL) {
    await pool.query(
      `INSERT INTO access_role_permissions (access_role_id, module_key, can_view, can_add, can_edit, can_delete, updated_at)
       SELECT ar.id, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP
       FROM access_roles ar
       WHERE ar.is_system_template = TRUE AND ar.name = $1
       ON CONFLICT (access_role_id, module_key) DO NOTHING`,
      [grant.role, grant.moduleKey, grant.view, grant.add, grant.edit, grant.del]
    );
  }
}

module.exports = {
  ensureTrainingModuleSchema,
};
