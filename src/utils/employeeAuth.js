const pool = require('../db');

async function getEmployeeIdFromAuth(auth) {
  const result = await pool.query(
    `SELECT COALESCE(u.employee_id, e.id) AS employee_id
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id OR e.work_email = u.email
     WHERE u.id = $1 AND u.email = $2`,
    [auth.userId, auth.email]
  );

  if (result.rowCount === 0 || !result.rows[0].employee_id) {
    return null;
  }

  return Number(result.rows[0].employee_id);
}

async function getEmployeeCompanyId(employeeId) {
  const result = await pool.query(
    'SELECT company_id FROM employees WHERE id = $1',
    [employeeId]
  );
  if (result.rowCount === 0 || !result.rows[0].company_id) return null;
  return Number(result.rows[0].company_id);
}

module.exports = {
  getEmployeeIdFromAuth,
  getEmployeeCompanyId,
};
