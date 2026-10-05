const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');
const { SYSTEM_MODULES_SEED } = require('../src/constants/systemModules.seed');
const {
  ACCESS_ROLE_TEMPLATES,
  matrixToDbRows,
} = require('../src/constants/accessRoleTemplates');

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS system_modules (
  module_key VARCHAR(80) PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'General',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS access_roles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  is_system_template BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT access_roles_company_name_unique UNIQUE (company_id, name)
)`,
  `CREATE INDEX IF NOT EXISTS access_roles_company_id_idx ON access_roles(company_id)`,
  `CREATE TABLE IF NOT EXISTS access_role_permissions (
  id BIGSERIAL PRIMARY KEY,
  access_role_id BIGINT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
  module_key VARCHAR(80) NOT NULL REFERENCES system_modules(module_key) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_add BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT access_role_permissions_role_module_unique UNIQUE (access_role_id, module_key)
)`,
  `CREATE INDEX IF NOT EXISTS access_role_permissions_role_id_idx ON access_role_permissions(access_role_id)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_role_id BIGINT REFERENCES access_roles(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS users_access_role_id_idx ON users(access_role_id)`,
];

async function seedSystemModules(client) {
  const activeKeys = SYSTEM_MODULES_SEED.map((m) => m.module_key);

  for (const mod of SYSTEM_MODULES_SEED) {
    await client.query(
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

  // Hide modules that are no longer part of the permission UI (e.g. uploads).
  await client.query(
    `UPDATE system_modules
     SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
     WHERE module_key <> ALL($1::varchar[])`,
    [activeKeys]
  );
}

async function upsertRolePermissionsBulk(client, roleId, matrix) {
  const rows = matrixToDbRows(matrix);
  if (rows.length === 0) return;

  const values = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, CURRENT_TIMESTAMP)`
    );
    params.push(
      roleId,
      row.module_key,
      row.can_view,
      row.can_add,
      row.can_edit,
      row.can_delete
    );
  }

  await client.query(
    `INSERT INTO access_role_permissions
       (access_role_id, module_key, can_view, can_add, can_edit, can_delete, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (access_role_id, module_key) DO UPDATE SET
       can_view = EXCLUDED.can_view,
       can_add = EXCLUDED.can_add,
       can_edit = EXCLUDED.can_edit,
       can_delete = EXCLUDED.can_delete,
       updated_at = CURRENT_TIMESTAMP`,
    params
  );
}

async function ensureCompanyTemplates(client, companyId) {
  const roleIdByName = {};

  for (const template of ACCESS_ROLE_TEMPLATES) {
    const existing = await client.query(
      `SELECT id FROM access_roles WHERE company_id = $1 AND name = $2 LIMIT 1`,
      [companyId, template.name]
    );

    let roleId;
    if (existing.rowCount > 0) {
      roleId = existing.rows[0].id;
    } else {
      const inserted = await client.query(
        `INSERT INTO access_roles (company_id, name, description, is_system_template, created_at, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [companyId, template.name, template.description, template.is_system_template]
      );
      roleId = inserted.rows[0].id;
    }

    roleIdByName[template.name] = roleId;
    await upsertRolePermissionsBulk(client, roleId, template.matrix);
  }

  return roleIdByName;
}

async function backfillUserAccessRoles(client, companyId, roleIdByName) {
  for (const template of ACCESS_ROLE_TEMPLATES) {
    const roleId = roleIdByName[template.name];
    if (!roleId || !template.legacy_user_roles?.length) continue;

    await client.query(
      `UPDATE users
       SET access_role_id = $1
       WHERE company_id = $2
         AND role = ANY($3::text[])
         AND access_role_id IS NULL`,
      [roleId, companyId, template.legacy_user_roles]
    );
  }
}

async function main() {
  console.log('Applying access-control schema...');
  for (const statement of DDL_STATEMENTS) {
    await pool.query(statement);
  }

  const client = await pool.connect();
  try {
    console.log('Seeding system modules...');
    await seedSystemModules(client);

    const companies = await client.query(`SELECT id FROM companies ORDER BY id ASC`);
    const total = companies.rowCount;
    console.log(`Seeding default roles for ${total} companies...`);

    let index = 0;
    for (const row of companies.rows) {
      index += 1;
      const roleIdByName = await ensureCompanyTemplates(client, row.id);
      await backfillUserAccessRoles(client, row.id, roleIdByName);
      if (index % 10 === 0 || index === total) {
        console.log(`  ${index}/${total} companies processed`);
      }
    }
  } finally {
    client.release();
  }

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM system_modules) AS modules,
      (SELECT COUNT(*)::int FROM access_roles) AS roles,
      (SELECT COUNT(*)::int FROM access_role_permissions) AS permissions,
      (SELECT COUNT(*)::int FROM users WHERE access_role_id IS NOT NULL) AS users_with_access_role
  `);
  console.log('Migration OK: access control ready');
  console.log(counts.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
