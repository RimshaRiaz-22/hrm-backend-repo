const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require('../src/db');

async function main() {
  console.log('=== Recent expense claims ===');
  const expenses = await pool.query(`
    SELECT r.id AS request_id, r.company_id, r.employee_id, r.status,
           e.first_name || ' ' || e.last_name AS employee_name,
           erd.paid_in, erd.reimbursement_status, erd.reimbursement_month,
           erd.reimbursement_date, erd.total_amount, erd.category, erd.payable_at
    FROM requests r
    JOIN expense_request_details erd ON erd.request_id = r.id
    JOIN employees e ON e.id = r.employee_id
    WHERE r.request_type = 'expense'
    ORDER BY r.id DESC
    LIMIT 10
  `);
  console.table(expenses.rows);

  console.log('\n=== Recent payroll runs ===');
  const runs = await pool.query(`
    SELECT pr.id, pr.period_month, pr.status, pr.closed_at,
           COUNT(pre.id)::int AS employee_count
    FROM payroll_runs pr
    LEFT JOIN payroll_run_employees pre ON pre.payroll_run_id = pr.id
    GROUP BY pr.id
    ORDER BY pr.id DESC
    LIMIT 5
  `);
  console.table(runs.rows);

  console.log('\n=== Expense lines in payroll ===');
  const lines = await pool.query(`
    SELECT pr.id AS run_id, pr.period_month, pr.status,
           e.first_name || ' ' || e.last_name AS employee_name,
           prl.line_kind, prl.label, prl.amount, prl.source_ref
    FROM payroll_run_lines prl
    JOIN payroll_run_employees pre ON pre.id = prl.payroll_run_employee_id
    JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
    JOIN employees e ON e.id = pre.employee_id
    WHERE prl.line_kind = 'expense'
    ORDER BY prl.id DESC
    LIMIT 20
  `);
  if (lines.rows.length === 0) {
    console.log('(no expense lines in any payroll run)');
  } else {
    console.table(lines.rows);
  }

  // Simulate fetchExpenses for latest approved salary expense
  const latest = expenses.rows.find(
    (r) => r.status === 'approved' && r.paid_in === 'salary' && r.reimbursement_status === 'payable'
  );
  if (latest) {
    const period = latest.reimbursement_month || '2026-07';
    console.log(`\n=== fetchExpenses simulation for employee ${latest.employee_id}, period ${period} ===`);
    const sim = await pool.query(
      `SELECT r.id, erd.total_amount, erd.reimbursement_month, erd.reimbursement_status, erd.paid_in
       FROM requests r
       JOIN expense_request_details erd ON erd.request_id = r.id
       WHERE r.company_id = $1 AND r.employee_id = $2
         AND r.request_type = 'expense'
         AND r.status = 'approved'
         AND erd.paid_in = 'salary'
         AND erd.reimbursement_status = 'payable'
         AND (
           erd.reimbursement_month = $3
           OR (
             erd.reimbursement_month IS NULL
             AND TO_CHAR(COALESCE(erd.reimbursement_date, erd.payable_at)::date, 'YYYY-MM') = $3
           )
         )`,
      [latest.company_id, latest.employee_id, period]
    );
    console.table(sim.rows);
  } else {
    console.log('\nNo approved salary+payable expense found to simulate.');
  }

  await pool.end();
}

async function checkEmployee(employeeId) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const pool = require('../src/db');
  const r = await pool.query(
    `SELECT pre.id, pre.employee_id, e.first_name, pr.id AS run_id, pr.period_month, pr.status, pr.company_id,
            (SELECT COALESCE(SUM(prl.amount),0) FROM payroll_run_lines prl
             WHERE prl.payroll_run_employee_id = pre.id AND prl.line_kind = 'expense') AS expense_total
     FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     JOIN employees e ON e.id = pre.employee_id
     WHERE e.id = $1
     ORDER BY pr.id DESC`,
    [employeeId]
  );
  console.table(r.rows);
  await pool.end();
}

if (process.argv[2] === 'employee') {
  checkEmployee(Number(process.argv[3])).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
