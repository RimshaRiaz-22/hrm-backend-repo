/**
 * Grant Performance module permissions to existing access roles.
 * Additive only — does not remove existing permissions.
 *
 * Run: node scripts/grant-performance-permissions.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const ALL_KEYS = [
  'performance_competencies',
  'performance_templates',
  'performance_goals',
  'performance_appraisals',
  'performance_pip',
];
const EMPLOYEE_KEYS = ['performance_goals', 'performance_appraisals', 'performance_pip'];

async function main() {
  const roles = await pool.query('SELECT id, name FROM access_roles');
  let upserts = 0;

  for (const role of roles.rows) {
    const leave = await pool.query(
      `SELECT can_view, can_add
       FROM access_role_permissions
       WHERE access_role_id = $1 AND module_key = 'leave_policies'`,
      [role.id]
    );
    if (!leave.rowCount || !leave.rows[0].can_view) continue;

    const full = Boolean(leave.rows[0].can_add);
    const keys = full ? ALL_KEYS : EMPLOYEE_KEYS;

    for (const key of keys) {
      await pool.query(
        `INSERT INTO access_role_permissions
           (access_role_id, module_key, can_view, can_add, can_edit, can_delete)
         VALUES ($1, $2, TRUE, $3, $3, $3)
         ON CONFLICT (access_role_id, module_key) DO UPDATE SET
           can_view = TRUE,
           can_add = CASE WHEN EXCLUDED.can_add THEN TRUE ELSE access_role_permissions.can_add END,
           can_edit = CASE WHEN EXCLUDED.can_edit THEN TRUE ELSE access_role_permissions.can_edit END,
           can_delete = CASE WHEN EXCLUDED.can_delete THEN TRUE ELSE access_role_permissions.can_delete END`,
        [role.id, key, full]
      );
      upserts += 1;
    }
  }

  console.log(`Roles scanned: ${roles.rowCount}; permission upserts: ${upserts}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
