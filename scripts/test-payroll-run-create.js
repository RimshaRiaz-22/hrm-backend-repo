require('dotenv').config();
const pool = require('../src/db');
const payrollRunService = require('../src/services/payrollRun.service');

async function main() {
  const admin = await pool.query(
    `SELECT u.id, u.email, u.company_id
     FROM users u
     WHERE u.company_id = 71 AND u.role = 'company_admin' AND u.is_active = TRUE
     LIMIT 1`
  );
  if (!admin.rowCount) {
    console.log('No company admin found');
    await pool.end();
    return;
  }

  const user = admin.rows[0];
  console.log('Using admin:', user.email, 'company:', user.company_id);

  const salaryCheck = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, ejd.salary, ejd.payroll_schedule_id
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1 AND ejd.payroll_schedule_id = 26
     ORDER BY e.id`,
    [user.company_id]
  );
  console.log('On schedule 26:', salaryCheck.rowCount);
  const noSalary = salaryCheck.rows.filter((r) => !r.salary || Number(r.salary) <= 0);
  console.log('On schedule 26 without salary:', noSalary.length, noSalary.slice(0, 5));

  const authUser = { userId: user.id, email: user.email };
  const body = {
    payroll_schedule_id: 26,
    period_month: '2026-07',
    pay_date: '2026-07-31',
    is_off_cycle: false,
  };

  try {
    const result = await payrollRunService.create(authUser, body);
    console.log('Result:', JSON.stringify(result, null, 2).slice(0, 2000));
  } catch (err) {
    console.error('THROWN ERROR:', err.message);
    console.error(err.stack);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
