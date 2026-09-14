require('dotenv').config();
const pool = require('../src/db');

async function main() {
  const col = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payroll_runs' AND column_name = 'skipped_employees'`
  );

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payroll_runs' ORDER BY ordinal_position`
  );

  const assigned = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ejd.payroll_schedule_id = 26)::int AS on_schedule_26,
            COUNT(*) FILTER (WHERE ejd.salary IS NOT NULL AND ejd.salary > 0)::int AS with_salary
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.employment_status != 'exited'`
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
