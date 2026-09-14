require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/db');

const email = process.argv[2] || 'rocof33466@rapplo.com';

async function main() {
  const user = await pool.query(
    `SELECT id, email, role, is_active, company_id, employee_id, access_role_id
     FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );

  const employee = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email, e.employee_code, e.company_id
     FROM employees e
     WHERE LOWER(e.work_email) = LOWER($1)
     LIMIT 1`,
    [email]
  );

  const employeeId = user.rows[0]?.employee_id || employee.rows[0]?.id;
  let payrollRuns = [];

  if (employeeId) {
    const runs = await pool.query(
      `SELECT pr.id, pr.period_month, pr.pay_date, pr.status, pr.closed_at, pre.net_pay, pre.gross_pay
       FROM payroll_run_employees pre
       JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
       WHERE pre.employee_id = $1
       ORDER BY pr.id DESC`,
      [employeeId]
    );
    payrollRuns = runs.rows;
  }

  let payslipPermission = null;
  if (user.rows[0]?.access_role_id) {
    const perm = await pool.query(
      `SELECT can_view, can_add, can_edit, can_delete
       FROM access_role_permissions
       WHERE access_role_id = $1 AND module_key = 'employee_payslips'`,
      [user.rows[0].access_role_id]
    );
    payslipPermission = perm.rows[0] || null;
  }

  const closedRuns = payrollRuns.filter((row) => row.status === 'closed');

  console.log('Employee payslip check for:', email);
  console.log('---');
  console.log('User account:', user.rows[0] || 'NOT FOUND');
  console.log('Employee profile:', employee.rows[0] || 'NOT FOUND');
  console.log('My Payslips permission:', payslipPermission || 'NOT SET (may block nav/API)');
  console.log('Resolved employee_id:', employeeId || 'NONE');
  console.log('---');
  console.log('Payroll runs including this employee:', payrollRuns.length);
  payrollRuns.forEach((row) => {
    console.log(
      `  Run #${row.id} | ${row.period_month} | status=${row.status} | net=${row.net_pay}`
    );
  });
  console.log('Closed runs (visible on My Payslips):', closedRuns.length);
  if (closedRuns.length === 0 && payrollRuns.length > 0) {
    console.log('ACTION: Close the draft/finalized run(s) in admin Payroll → Run Payroll.');
  } else if (payrollRuns.length === 0) {
    console.log('ACTION: Create a payroll run including this employee, then close it.');
  } else if (closedRuns.length > 0) {
    console.log('ACTION: Refresh My Payslips page (frontend fix applied for API response path).');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
