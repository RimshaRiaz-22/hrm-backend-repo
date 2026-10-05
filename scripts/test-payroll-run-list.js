require('dotenv').config();
const pool = require('../src/db');
const payrollRunService = require('../src/services/payrollRun.service');

async function main() {
  const admin = await pool.query(
    `SELECT id, email FROM users WHERE company_id = 71 AND role = 'company_admin' LIMIT 1`
  );
  const authUser = { userId: admin.rows[0].id, email: admin.rows[0].email };
  const result = await payrollRunService.list(authUser, {});
  console.log(JSON.stringify(result, null, 2).slice(0, 1500));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
