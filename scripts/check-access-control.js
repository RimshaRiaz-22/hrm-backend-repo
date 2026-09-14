require('dotenv').config();
const pool = require('../src/db');

(async () => {
  const companies = await pool.query('SELECT COUNT(*)::int AS c FROM companies');
  console.log('companies:', companies.rows[0].c);
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('system_modules', 'access_roles', 'access_role_permissions')`
  );
  console.log('rbac tables:', tables.rows.map((r) => r.table_name));
  if (tables.rows.length) {
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM system_modules) AS modules,
        (SELECT COUNT(*)::int FROM access_roles) AS roles,
        (SELECT COUNT(*)::int FROM access_role_permissions) AS permissions,
        (SELECT COUNT(*)::int FROM users WHERE access_role_id IS NOT NULL) AS users_with_role
    `);
    console.log(counts.rows[0]);
  }
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
