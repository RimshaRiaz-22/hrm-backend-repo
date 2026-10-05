const pool = require('../db');
const emailService = require('./email.service');
const { getAuthenticatedCompanyAdmin, parsePositiveInt } = require('./payrollAssignment.service');
const { parseFilters } = require('./payslip/buildPayslipFromRun');
const {
  generateTaxCertificatePdf,
  buildTaxCertificateFilename,
} = require('./taxCertificate/taxCertificatePdf');

function parseTaxYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return year;
}

function buildEmployeeName(row) {
  const parts = [row.first_name, row.last_name].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' ') || 'Employee';
}

function buildTaxCertificateEmailContent({ employee_name, company_name, tax_year }) {
  const subject = `Tax Certificate ${tax_year} - ${company_name}`;
  const greeting = `Dear ${employee_name},`;
  const intro = `Please find attached your tax certificate for tax year ${tax_year}.`;
  const closing = `Regards,\n${company_name} HR`;

  return {
    subject,
    text: [greeting, '', intro, '', closing].join('\n'),
    html: `<p>${greeting}</p><p>${intro}</p><p>Regards,<br/>${company_name} HR</p>`,
  };
}

async function fetchCompanyBranding(companyId) {
  const result = await pool.query(`SELECT name, logo_url FROM companies WHERE id = $1`, [companyId]);
  return {
    companyName: result.rows[0]?.name || 'Company',
    companyLogoUrl: result.rows[0]?.logo_url || null,
  };
}

async function listCandidateEmployees(companyId, filters = {}) {
  const params = [companyId];
  const conditions = ['e.company_id = $1', "e.employment_status != 'exited'"];

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
    conditions.push(`e.id = ANY($${params.length}::bigint[])`);
  }

  const result = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email, e.employee_code, ejd.currency
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.first_name ASC, e.last_name ASC`,
    params
  );

  return result.rows;
}

async function aggregateEmployeeTaxYear(companyId, employeeId, taxYear) {
  const periodPrefix = `${taxYear}-%`;

  const incomeResult = await pool.query(
    `SELECT COALESCE(SUM(pre.gross_pay), 0) AS total_income
     FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     WHERE pr.company_id = $1
       AND pr.status = 'closed'
       AND pr.period_month LIKE $2
       AND pre.employee_id = $3`,
    [companyId, periodPrefix, employeeId]
  );

  const taxResult = await pool.query(
    `SELECT COALESCE(SUM(prl.amount), 0) AS total_tax
     FROM payroll_run_lines prl
     JOIN payroll_run_employees pre ON pre.id = prl.payroll_run_employee_id
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     WHERE pr.company_id = $1
       AND pr.status = 'closed'
       AND pr.period_month LIKE $2
       AND pre.employee_id = $3
       AND prl.line_kind = 'deduction'
       AND (
         LOWER(prl.label) LIKE '%tax%'
         OR EXISTS (
           SELECT 1
           FROM pay_elements pe
           WHERE prl.source_ref = CONCAT('pay_element:', pe.id::text)
             AND pe.company_id = pr.company_id
             AND pe.kind = 'deduction'
             AND (
               LOWER(pe.name) LIKE '%tax%'
               OR LOWER(pe.payslip_name) LIKE '%tax%'
               OR LOWER(COALESCE(pe.category, '')) LIKE '%tax%'
             )
         )
       )`,
    [companyId, periodPrefix, employeeId]
  );

  const totalIncome = parseFloat(incomeResult.rows[0]?.total_income) || 0;
  const totalTax = parseFloat(taxResult.rows[0]?.total_tax) || 0;

  if (totalIncome <= 0) {
    return null;
  }

  return {
    total_income: totalIncome,
    total_tax: totalTax,
  };
}

async function upsertTaxCertificate(client, companyId, employeeId, taxYear, totals) {
  const result = await client.query(
    `INSERT INTO tax_certificates (
       company_id, employee_id, tax_year, total_income, total_tax, sent_at
     ) VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'UTC'))
     ON CONFLICT (employee_id, tax_year)
     DO UPDATE SET
       company_id = EXCLUDED.company_id,
       total_income = EXCLUDED.total_income,
       total_tax = EXCLUDED.total_tax,
       sent_at = EXCLUDED.sent_at
     RETURNING id, employee_id, tax_year, total_income, total_tax, sent_at`,
    [companyId, employeeId, taxYear, totals.total_income, totals.total_tax]
  );
  return result.rows[0];
}

async function generateAndSend(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const taxYear = parseTaxYear(body.tax_year);
  if (!taxYear) {
    return { error: [400, 'tax_year is required and must be between 2000 and 2100.'] };
  }

  const filtersParsed = parseFilters(body);
  if (filtersParsed.error) return filtersParsed;

  const companyId = Number(auth.admin.company_id);
  const { companyName, companyLogoUrl } = await fetchCompanyBranding(companyId);
  const employees = await listCandidateEmployees(companyId, filtersParsed.filters);

  if (employees.length === 0) {
    return { error: [400, 'No employees matched the selected filters.'] };
  }

  const sent = [];
  const skipped = [];
  const client = await pool.connect();

  try {
    for (const employee of employees) {
      const employeeId = Number(employee.id);
      const totals = await aggregateEmployeeTaxYear(companyId, employeeId, taxYear);

      if (!totals) {
        skipped.push({
          employee_id: employeeId,
          reason: `No closed payroll runs found for tax year ${taxYear}.`,
        });
        continue;
      }

      const to = String(employee.work_email || '').trim();
      if (!to) {
        skipped.push({
          employee_id: employeeId,
          reason: 'No work email on employee profile.',
        });
        continue;
      }

      const employeeName = buildEmployeeName(employee);
      const currency = String(employee.currency || 'PKR').trim() || 'PKR';
      const pdfBuffer = await generateTaxCertificatePdf({
        company_name: companyName,
        company_logo_url: companyLogoUrl,
        employee_name: employeeName,
        employee_code: employee.employee_code || '',
        tax_year: taxYear,
        total_income: totals.total_income,
        total_tax: totals.total_tax,
        currency,
      });
      const filename = buildTaxCertificateFilename({
        employee_code: employee.employee_code,
        tax_year: taxYear,
      });
      const emailContent = buildTaxCertificateEmailContent({
        employee_name: employeeName,
        company_name: companyName,
        tax_year: taxYear,
      });

      const emailResult = await emailService.sendTaxCertificateEmail({
        to,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
        pdfBuffer,
        attachmentFilename: filename,
      });

      if (!emailResult.sent) {
        skipped.push({
          employee_id: employeeId,
          reason: emailResult.reason || 'Failed to send tax certificate email.',
        });
        continue;
      }

      await client.query('BEGIN');
      try {
        const record = await upsertTaxCertificate(client, companyId, employeeId, taxYear, totals);
        await client.query('COMMIT');

        sent.push({
          employee_id: employeeId,
          email: to,
          tax_year: taxYear,
          total_income: parseFloat(record.total_income),
          total_tax: parseFloat(record.total_tax),
          filename,
          message_id: emailResult.message_id || null,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        skipped.push({
          employee_id: employeeId,
          reason: error.message || 'Failed to save tax certificate record.',
        });
      }
    }
  } finally {
    client.release();
  }

  return { sent, skipped };
}

async function list(authUser, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const companyId = Number(auth.admin.company_id);
  const params = [companyId];
  const conditions = ['tc.company_id = $1'];

  if (query.tax_year) {
    const taxYear = parseTaxYear(query.tax_year);
    if (!taxYear) return { error: [400, 'tax_year must be between 2000 and 2100.'] };
    params.push(taxYear);
    conditions.push(`tc.tax_year = $${params.length}`);
  }

  if (query.employee_id) {
    const employeeId = parsePositiveInt(query.employee_id);
    if (!employeeId) return { error: [400, 'employee_id must be a positive integer.'] };
    params.push(employeeId);
    conditions.push(`tc.employee_id = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT tc.id, tc.company_id, tc.employee_id, tc.tax_year, tc.total_income, tc.total_tax,
            tc.sent_at, tc.created_at,
            e.first_name, e.last_name, e.employee_code, e.work_email
     FROM tax_certificates tc
     JOIN employees e ON e.id = tc.employee_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY tc.tax_year DESC, e.first_name ASC, e.last_name ASC`,
    params
  );

  return {
    items: result.rows.map((row) => ({
      id: Number(row.id),
      employee_id: Number(row.employee_id),
      employee_name: buildEmployeeName(row),
      employee_code: row.employee_code || '',
      work_email: row.work_email || '',
      tax_year: Number(row.tax_year),
      total_income: parseFloat(row.total_income),
      total_tax: parseFloat(row.total_tax),
      sent_at: row.sent_at,
      created_at: row.created_at,
    })),
    count: result.rowCount,
  };
}

module.exports = {
  generateAndSend,
  list,
};
