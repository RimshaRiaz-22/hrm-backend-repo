require('dotenv').config();
const pool = require('../src/db');

async function main() {
  const schedule = await pool.query(`SELECT id, company_id, name FROM payroll_schedules WHERE id = 26`);
 

  const byCompany = await pool.query(
    `SELECT e.company_id, COUNT(*)::int AS cnt
     FROM employees e
     JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE ejd.payroll_schedule_id = 26
     GROUP BY e.company_id`
  );


  const admins = await pool.query(
    `SELECT u.id, u.email, u.company_id, c.name AS company_name
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.role = 'company_admin' AND u.is_active = TRUE`
  );
 

  await pool.end();
}

main().catch(console.error);
