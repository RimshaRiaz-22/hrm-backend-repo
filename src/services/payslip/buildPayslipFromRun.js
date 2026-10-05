const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const pool = require('../../db');
const { parsePositiveInt } = require('../payrollAssignment.service');
const { normalizePayDate } = require('./payslipFormat');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

function extractUploadFilename(logoUrl) {
  const value = String(logoUrl || '').trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/uploads\/([^/?#]+)$/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    const match = value.match(/\/uploads\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function readLogoBufferFromUploads(logoUrl) {
  const filename = extractUploadFilename(logoUrl);
  if (!filename) return null;

  const filePath = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return null;

  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function fetchRemoteImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const request = lib.get(url, { timeout: 10000 }, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        fetchRemoteImageBuffer(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch logo (${response.statusCode})`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Logo fetch timed out'));
    });
  });
}

async function resolveCompanyLogoBuffer(logoUrl) {
  const value = String(logoUrl || '').trim();
  if (!value) return null;

  const localBuffer = readLogoBufferFromUploads(value);
  if (localBuffer) return localBuffer;

  if (/^https?:\/\//i.test(value)) {
    try {
      return await fetchRemoteImageBuffer(value);
    } catch (error) {
      console.error(`Payslip logo fetch failed for "${value}":`, error.message);
      return null;
    }
  }

  return null;
}

function buildCompanyAddress(row) {
  const parts = [row.country, row.timezone].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' • ') || '';
}

function buildEmployeeName(row) {
  const parts = [row.first_name, row.last_name].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' ') || 'Employee';
}

function workingDaysFromSchedule(row) {
  const start = Number(row.start_day) || 1;
  const end = Number(row.end_day) || 30;
  return Math.max(1, end - start + 1);
}

function parseFilters(body = {}) {
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  const out = {};

  if (filters.department_id != null) {
    const id = parsePositiveInt(filters.department_id);
    if (!id) return { error: [400, 'filters.department_id must be a positive integer.'] };
    out.department_id = id;
  }

  if (filters.work_location_id != null) {
    const id = parsePositiveInt(filters.work_location_id);
    if (!id) return { error: [400, 'filters.work_location_id must be a positive integer.'] };
    out.work_location_id = id;
  }

  if (filters.employee_ids != null) {
    if (!Array.isArray(filters.employee_ids) || filters.employee_ids.length === 0) {
      return { error: [400, 'filters.employee_ids must be a non-empty array.'] };
    }
    const ids = [];
    for (const raw of filters.employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: [400, 'Each filters.employee_id must be a positive integer.'] };
      ids.push(id);
    }
    out.employee_ids = [...new Set(ids)];
  }

  return { filters: out };
}

function mapLineRow(row) {
  return {
    id: Number(row.id),
    line_kind: row.line_kind,
    label: row.label,
    amount: parseFloat(row.amount),
    source_ref: row.source_ref || null,
  };
}

function assemblePayslipData(row, lines, logoBuffer = null) {
  const workingDays = workingDaysFromSchedule(row);
  const presentDays = parseFloat(row.present_days) || 0;
  const absentDays = parseFloat(row.absent_days) || 0;

  return {
    payroll_run_id: Number(row.payroll_run_id),
    payroll_run_employee_id: Number(row.payroll_run_employee_id),
    company: {
      name: row.company_name || 'Company',
      address: buildCompanyAddress(row),
      logo_url: row.logo_url || null,
      logo_buffer: logoBuffer || null,
    },
    run: {
      period_month: row.period_month,
      pay_date: normalizePayDate(row.pay_date) || row.pay_date,
      is_off_cycle: Boolean(row.is_off_cycle),
    },
    employee: {
      id: Number(row.employee_id),
      name: buildEmployeeName(row),
      employee_code: row.employee_code || '',
      designation: row.designation_name || row.designation || '',
      department: row.department_name || row.department || '',
      email: String(row.work_email || '').trim(),
    },
    attendance: {
      present_days: presentDays,
      absent_days: absentDays,
      working_days: workingDays > 0 ? workingDays : presentDays + absentDays,
    },
    totals: {
      basic_salary: parseFloat(row.basic_salary),
      total_allowances: parseFloat(row.total_allowances),
      total_deductions: parseFloat(row.total_deductions),
      total_contributions: parseFloat(row.total_contributions),
      gross_pay: parseFloat(row.gross_pay),
      net_pay: parseFloat(row.net_pay),
    },
    lines: lines.map(mapLineRow),
    currency: String(row.currency || row.company_currency || 'PKR').trim() || 'PKR',
    salary_template: row.template_id
      ? {
          id: Number(row.template_id),
          name: row.template_name,
        }
      : null,
    payslip_password_protected: row.payslip_password_protected === true,
    employee_code: row.employee_code || '',
    national_id: row.national_id || '',
  };
}

async function fetchRunEmployeeRow(client, companyId, runId, employeeId) {
  const result = await client.query(
    `SELECT pr.id AS payroll_run_id, pr.period_month, pr.pay_date, pr.is_off_cycle, pr.status,
            pre.id AS payroll_run_employee_id, pre.basic_salary, pre.present_days, pre.absent_days,
            pre.total_allowances, pre.total_deductions, pre.total_contributions, pre.gross_pay, pre.net_pay,
            e.id AS employee_id, e.first_name, e.last_name, e.work_email, e.employee_code, e.national_id,
            ejd.currency, ejd.designation, ejd.department,
            d.name AS department_name, des.name AS designation_name,
            c.name AS company_name, c.logo_url, c.country, c.timezone, c.currency AS company_currency,
            c.payslip_password_protected,
            ps.start_day, ps.end_day,
            st.id AS template_id, st.name AS template_name
     FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     JOIN employees e ON e.id = pre.employee_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN departments d ON d.id = ejd.department_id AND d.company_id = e.company_id
     LEFT JOIN designations des ON des.id = ejd.designation_id AND des.company_id = e.company_id
     LEFT JOIN companies c ON c.id = pr.company_id
     LEFT JOIN payroll_schedules ps ON ps.id = pr.payroll_schedule_id
     LEFT JOIN salary_templates st ON st.id = ejd.salary_template_id AND st.company_id = e.company_id
     WHERE pr.id = $1 AND pr.company_id = $2 AND pre.employee_id = $3`,
    [runId, companyId, employeeId]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function fetchRunLines(client, payrollRunEmployeeId) {
  const result = await client.query(
    `SELECT id, line_kind, label, amount, source_ref
     FROM payroll_run_lines
     WHERE payroll_run_employee_id = $1
     ORDER BY id ASC`,
    [payrollRunEmployeeId]
  );
  return result.rows;
}

async function assertClosedRun(client, companyId, runId) {
  const result = await client.query(
    `SELECT id, status, period_month, pay_date
     FROM payroll_runs
     WHERE id = $1 AND company_id = $2`,
    [runId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, 'Payroll run not found.'] };
  }
  if (result.rows[0].status !== 'closed') {
    return { error: [400, 'Payroll run must be closed before accessing payslips.'] };
  }
  return { run: result.rows[0] };
}

async function buildPayslipData(companyId, runId, employeeId) {
  const client = await pool.connect();
  try {
    const runCheck = await assertClosedRun(client, companyId, runId);
    if (runCheck.error) return runCheck;

    const row = await fetchRunEmployeeRow(client, companyId, runId, employeeId);
    if (!row) {
      return { error: [404, 'Employee not found in this payroll run.'] };
    }

    const lines = await fetchRunLines(client, Number(row.payroll_run_employee_id));
    const logoBuffer = await resolveCompanyLogoBuffer(row.logo_url);
    return { payslipData: assemblePayslipData(row, lines, logoBuffer) };
  } finally {
    client.release();
  }
}

async function listRunEmployeeIds(companyId, runId, filters = {}) {
  const params = [runId, companyId];
  const conditions = ['pre.payroll_run_id = $1', 'e.company_id = $2'];

  if (filters.department_id) {
    params.push(filters.department_id);
    conditions.push(`ejd.department_id = $${params.length}`);
  }
  if (filters.work_location_id) {
    params.push(filters.work_location_id);
    conditions.push(`ejd.work_location_id = $${params.length}`);
  }
  if (filters.employee_ids?.length) {
    params.push(filters.employee_ids);
    conditions.push(`pre.employee_id = ANY($${params.length}::bigint[])`);
  }

  const result = await pool.query(
    `SELECT pre.employee_id, e.work_email, e.employee_code, e.national_id
     FROM payroll_run_employees pre
     JOIN employees e ON e.id = pre.employee_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.first_name ASC, e.last_name ASC`,
    params
  );

  return result.rows.map((row) => ({
    employee_id: Number(row.employee_id),
    work_email: String(row.work_email || '').trim(),
    employee_code: row.employee_code || '',
    national_id: row.national_id || '',
  }));
}

module.exports = {
  buildPayslipData,
  assertClosedRun,
  listRunEmployeeIds,
  parseFilters,
  assemblePayslipData,
};
