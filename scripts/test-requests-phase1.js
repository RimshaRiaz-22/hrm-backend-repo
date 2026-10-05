require('dotenv').config();
const pool = require('../src/db');
const requestsService = require('../src/services/requests.service');

async function main() {
  const match = await pool.query(`
    SELECT e.id AS employee_id, e.company_id, eu.id AS user_id, eu.email AS employee_email,
           au.id AS admin_id, au.email AS admin_email
    FROM employees e
    JOIN users eu ON eu.employee_id = e.id AND eu.role = 'employee'
    JOIN users au ON au.company_id = e.company_id AND au.role = 'company_admin'
    LIMIT 1
  `);

  if (match.rowCount === 0) {
   
    await pool.end();
    return;
  }

  const employee = match.rows[0];
  const authEmployee = { userId: employee.user_id, email: employee.employee_email };
  const authAdmin = { userId: employee.admin_id, email: employee.admin_email };

  const today = new Date();
  const baseOffset = Number(String(Date.now()).slice(-2));
  const day1 = new Date(today);
  day1.setDate(day1.getDate() - (10 + baseOffset));
  const day2 = new Date(today);
  day2.setDate(day2.getDate() - (11 + baseOffset));
  const day3 = new Date(today);
  day3.setDate(day3.getDate() - (12 + baseOffset));
  const day4 = new Date(today);
  day4.setDate(day4.getDate() - (13 + baseOffset));

  const fmt = (d) => d.toISOString().slice(0, 10);
  const correctionDate = fmt(day1);
  const createResult = await requestsService.createRequest(authEmployee, {
    request_type: 'attendance_correction',
    details: {
      correction_date: correctionDate,
      corrected_check_in: `${correctionDate}T05:05:00.000Z`,
      corrected_check_out: `${correctionDate}T14:10:00.000Z`,
      reason: 'Phase 1 automated test - forgot biometric',
    },
  });

  if (createResult.error) {
    console.error('CREATE FAILED:', createResult.error);
    await pool.end();
    process.exit(1);
  }

  const requestId = createResult.data.id;
 

  const pending = await requestsService.listPendingRequests(authAdmin, {
    request_type: 'attendance_correction',
  });
  const foundPending = pending.data.items.some((item) => item.id === requestId);
  

  const approveResult = await requestsService.approveRequest(authAdmin, requestId);
  if (approveResult.error) {
    console.error('APPROVE FAILED:', approveResult.error);
    await pool.end();
    process.exit(1);
  }
  

  const punches = await pool.query(
    `SELECT action_type, punched_at, source, remarks, attendance_status
     FROM attendance_punches
     WHERE employee_id = $1 AND attendance_date = $2
     ORDER BY punched_at ASC`,
    [employee.employee_id, correctionDate]
  );

  // Create another request to test reject + cancel
  const create2 = await requestsService.createRequest(authEmployee, {
    request_type: 'attendance_correction',
    details: {
      correction_date: fmt(day2),
      corrected_check_in: `${fmt(day2)}T05:00:00.000Z`,
      corrected_check_out: `${fmt(day2)}T14:00:00.000Z`,
      reason: 'Test reject flow',
    },
  });
  const rejectId = create2.data.id;
  const rejectResult = await requestsService.rejectRequest(authAdmin, rejectId, 'Not enough detail');

  const create3 = await requestsService.createRequest(authEmployee, {
    request_type: 'attendance_correction',
    details: {
      correction_date: fmt(day3),
      corrected_check_in: `${fmt(day3)}T05:00:00.000Z`,
      corrected_check_out: `${fmt(day3)}T14:00:00.000Z`,
      reason: 'Test cancel flow',
    },
  });
  const cancelId = create3.data.id;
  const cancelResult = await requestsService.cancelRequest(authEmployee, cancelId);


  const duplicate = await requestsService.createRequest(authEmployee, {
    request_type: 'attendance_correction',
    details: {
      correction_date: fmt(day3),
      corrected_check_in: `${fmt(day3)}T05:00:00.000Z`,
      corrected_check_out: `${fmt(day3)}T14:00:00.000Z`,
      reason: 'Should fail duplicate',
    },
  });
  console.log('Duplicate blocked:', Boolean(duplicate.error));


  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
