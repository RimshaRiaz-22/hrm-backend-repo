const pool = require('../../db');
const fs = require('fs');
const path = require('path');
const { USER_ROLES } = require('../../constants/userRoles');
const { resolveEmployeeElements } = require('../payrollAssignment.service');
const { buildPayslipDataFromEmployeeProfile } = require('./buildPayslipFromEmployee');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function buildEmployeeName(row) {
  const parts = [row.first_name, row.last_name].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' ') || 'Employee';
}

function readLogoBufferFromUrl(logoUrl) {
  const value = String(logoUrl || '').trim();
  if (!value) return null;

  const match = value.match(/\/uploads\/([^/?#]+)/i);
  if (!match?.[1]) return null;

  const filePath = path.join(UPLOAD_DIR, path.basename(decodeURIComponent(match[1])));
  if (!fs.existsSync(filePath)) return null;

  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function buildCompanyAddress(row) {
  const parts = [row.country, row.timezone].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' • ') || '';
}

async function getCompanyAdmin(authUser) {
  const userResult = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (userResult.rowCount === 0) {
    return { error: [401, 'Authenticated user not found.'] };
  }

  const admin = userResult.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active || !admin.company_id) {
    return { error: [403, 'Your account must be active and linked to a company.'] };
  }

  return { admin };
}

async function fetchEmployeePayslipRow(client, employeeId, companyId = null) {
  const params = companyId ? [employeeId, companyId] : [employeeId];
  const companyFilter = companyId ? ' AND e.company_id = $2' : '';

  const employeeResult = await client.query(
    `SELECT e.id, e.company_id, e.first_name, e.last_name, e.work_email, e.employee_code, e.employment_status,
            ejd.salary_template_id, ejd.salary, ejd.currency, ejd.designation, ejd.department,
            d.name AS department_name, des.name AS designation_name,
            c.name AS company_name, c.logo_url, c.country, c.timezone, c.currency AS company_currency,
            c.payslip_password_protected,
            st.id AS template_id, st.name AS template_name
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN departments d ON d.id = ejd.department_id AND d.company_id = e.company_id
     LEFT JOIN designations des ON des.id = ejd.designation_id AND des.company_id = e.company_id
     LEFT JOIN companies c ON c.id = e.company_id
     LEFT JOIN salary_templates st ON st.id = ejd.salary_template_id AND st.company_id = e.company_id
     WHERE e.id = $1${companyFilter}`,
    params
  );

  if (employeeResult.rowCount === 0) {
    return { error: [404, 'Employee not found.'] };
  }

  return { row: employeeResult.rows[0] };
}

async function buildPayslipBundleFromRow(client, row, options = {}) {
  if (row.employment_status === 'exited') {
    return { error: [400, 'Cannot generate payslip for an exited employee.'] };
  }
  if (!row.salary_template_id) {
    return {
      error: [400, 'Assign a salary template to this employee before generating a payslip.'],
    };
  }

  const workEmail = String(row.work_email || '').trim();
  const { elements } = await resolveEmployeeElements(
    client,
    Number(row.company_id),
    Number(row.id),
    Number(row.salary_template_id)
  );

  const payslipData = buildPayslipDataFromEmployeeProfile({
    employeeRow: {
      id: row.id,
      name: buildEmployeeName(row),
      employee_code: row.employee_code || '',
      designation: row.designation_name || row.designation || '',
      department: row.department_name || row.department || '',
      work_email: workEmail,
      salary: row.salary,
      currency: row.currency || row.company_currency || 'PKR',
    },
    companyRow: {
      company_id: row.company_id || null,
      company_name: row.company_name || 'Company',
      company_address: buildCompanyAddress(row),
      logo_url: row.logo_url || null,
      logo_buffer: readLogoBufferFromUrl(row.logo_url),
      currency: row.company_currency || 'PKR',
    },
    template: row.template_id ? { id: row.template_id, name: row.template_name } : null,
    elements,
    periodMonth: options.periodMonth,
  });

  return {
    payslipData,
    to: workEmail || null,
    passwordProtected: row.payslip_password_protected === true,
    templateName: row.template_name || null,
    elementCount: elements.length,
  };
}

async function buildPayslipDataForEmployee(authUser, employeeId, options = {}) {
  const auth = await getCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) {
    return { error: [400, 'employee_id must be a positive integer.'] };
  }

  const client = await pool.connect();
  try {
    const fetched = await fetchEmployeePayslipRow(client, id, auth.admin.company_id);
    if (fetched.error) return { error: fetched.error };
    return await buildPayslipBundleFromRow(client, fetched.row, options);
  } finally {
    client.release();
  }
}

async function buildPayslipDataForEmployeeId(employeeId, options = {}) {
  const id = parsePositiveInt(employeeId);
  if (!id) {
    throw new Error('employee_id must be a positive integer.');
  }

  const client = await pool.connect();
  try {
    const fetched = await fetchEmployeePayslipRow(client, id);
    if (fetched.error) {
      throw new Error(fetched.error[1]);
    }
    const built = await buildPayslipBundleFromRow(client, fetched.row, options);
    if (built.error) {
      throw new Error(built.error[1]);
    }
    return built;
  } finally {
    client.release();
  }
}

async function resolveTestEmployeeId(preferredEmployeeId = null) {
  const fromEnv = parsePositiveInt(preferredEmployeeId || process.env.PAYSLIP_TEST_EMPLOYEE_ID);
  if (fromEnv) return fromEnv;

  const result = await pool.query(
    `SELECT e.id
     FROM employees e
     JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.employment_status != 'exited'
       AND ejd.salary_template_id IS NOT NULL
       AND ejd.salary IS NOT NULL
       AND ejd.salary > 0
     ORDER BY e.id ASC
     LIMIT 1`
  );

  if (result.rowCount === 0) {
    throw new Error(
      'No employee with an assigned salary template and basic salary found. Set PAYSLIP_TEST_EMPLOYEE_ID in .env or assign a template + salary to an employee.'
    );
  }

  return Number(result.rows[0].id);
}

async function loadTemplatePayslipDataForTests(options = {}) {
  const employeeId = await resolveTestEmployeeId(options.employeeId);
  const built = await buildPayslipDataForEmployeeId(employeeId, options);
  return {
    employeeId,
    ...built,
  };
}

async function resolveEmployeeForPayslipTest(authUser, employeeId, options = {}) {
  const built = await buildPayslipDataForEmployee(authUser, employeeId, options);
  if (built.error) return built;

  if (!built.to) {
    return {
      error: [400, 'Employee work email is not set. Add a work email on the employee profile first.'],
    };
  }

  return built;
}

module.exports = {
  buildPayslipDataForEmployee,
  buildPayslipDataForEmployeeId,
  loadTemplatePayslipDataForTests,
  resolveTestEmployeeId,
  resolveEmployeeForPayslipTest,
};
