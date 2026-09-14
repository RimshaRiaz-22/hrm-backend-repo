require('dotenv').config();
const pool = require('../src/db');

const TABLES = [
  'payroll_schedules',
  'pay_elements',
  'salary_templates',
  'salary_template_items',
  'employee_pay_elements',
  'monthly_inputs',
  'payroll_runs',
  'payroll_run_employees',
  'payroll_run_lines',
  'tax_certificates',
];

(async () => {
  let ok = true;
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
    const exists = rows[0].reg !== null;
    if (!exists) ok = false;
  }
  await pool.end();
  process.exit(ok ? 0 : 1);
})();
