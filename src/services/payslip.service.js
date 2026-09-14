/** Payslip PDF generation, closed-run data assembly, and email delivery. */

const emailService = require('./email.service');
const { generatePayslipPdf, buildPayslipFilename } = require('./payslip/payslipPdf');
const { buildPayslipEmailContent } = require('./payslip/payslipEmail');
const {
  buildPayslipData: buildPayslipDataFromRun,
  listRunEmployeeIds,
  parseFilters,
  assertClosedRun,
} = require('./payslip/buildPayslipFromRun');
const { derivePayslipPassword, buildPayslipPasswordHint } = require('./payslip/payslipPassword');
const { getAuthenticatedCompanyAdmin, parsePositiveInt } = require('./payrollAssignment.service');
const pool = require('../db');
const {
  getMockPayslipData,
  overlayEmployeeOnPayslipData,
  overlayCompanyOnPayslipData,
  standardPayslipData,
  minimalPayslipData,
  heavyLineItemsPayslipData,
  zeroNetPayPayslipData,
} = require('./payslip/mockPayslipData');

async function sendPayslipEmail(payslipData, options = {}) {
  if (!payslipData || typeof payslipData !== 'object') {
    throw new Error('payslipData is required.');
  }

  const to = options.to || payslipData.employee?.email;
  const password = options.password ? String(options.password) : null;
  const passwordProtected = Boolean(password || options.passwordProtected);
  const pdfBuffer = await generatePayslipPdf(payslipData, { password });
  const filename = buildPayslipFilename(payslipData);
  const emailContent = buildPayslipEmailContent(payslipData, {
    passwordProtected,
    passwordHint: options.passwordHint,
  });

  const result = await emailService.sendPayslipEmail({
    to,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
    pdfBuffer,
    attachmentFilename: filename,
    companyId: emailContent.companyId,
    companyName: emailContent.companyName,
    companyLogoUrl: emailContent.companyLogoUrl,
  });

  return {
    ...result,
    filename,
    subject: emailContent.subject,
    attachment_bytes: pdfBuffer?.length || 0,
  };
}

async function buildPayslipData(companyId, runId, employeeId) {
  return buildPayslipDataFromRun(companyId, runId, employeeId);
}

async function emailPayslips(authUser, runIdRaw, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;

  const runId = parsePositiveInt(runIdRaw);
  if (!runId) return { error: [400, 'Run id must be a positive integer.'] };

  const filtersParsed = parseFilters(body);
  if (filtersParsed.error) return filtersParsed;

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();
  let runCheck;
  try {
    runCheck = await assertClosedRun(client, companyId, runId);
  } finally {
    client.release();
  }
  if (runCheck.error) return runCheck;

  const employees = await listRunEmployeeIds(companyId, runId, filtersParsed.filters);
  if (employees.length === 0) {
    return { error: [400, 'No employees matched the selected filters for this payroll run.'] };
  }

  const sent = [];
  const failed = [];

  for (const employee of employees) {
    const built = await buildPayslipData(companyId, runId, employee.employee_id);
    if (built.error) {
      failed.push({
        employee_id: employee.employee_id,
        reason: built.error[1],
      });
      continue;
    }

    const payslipData = built.payslipData;
    const to = String(payslipData.employee?.email || employee.work_email || '').trim();
    if (!to) {
      failed.push({
        employee_id: employee.employee_id,
        reason: 'No work email on employee profile.',
      });
      continue;
    }

    const passwordProtected = payslipData.payslip_password_protected === true;
    const password = passwordProtected
      ? derivePayslipPassword({
          employee_code: payslipData.employee?.employee_code || employee.employee_code,
          national_id: employee.national_id,
          email: to,
        })
      : null;

    if (passwordProtected && !password) {
      failed.push({
        employee_id: employee.employee_id,
        reason: 'Could not derive payslip password for this employee.',
      });
      continue;
    }

    try {
      const result = await sendPayslipEmail(payslipData, {
        to,
        password,
        passwordProtected,
        passwordHint: buildPayslipPasswordHint(password, payslipData),
      });

      if (!result.sent) {
        failed.push({
          employee_id: employee.employee_id,
          email: to,
          reason: result.reason || 'Failed to send payslip email.',
        });
        continue;
      }

      sent.push({
        employee_id: employee.employee_id,
        email: to,
        filename: result.filename,
        message_id: result.message_id || null,
      });
    } catch (error) {
      failed.push({
        employee_id: employee.employee_id,
        email: to,
        reason: error.message || 'Failed to send payslip email.',
      });
    }
  }

  return { sent, failed };
}

module.exports = {
  generatePayslipPdf,
  buildPayslipEmailContent,
  buildPayslipFilename,
  sendPayslipEmail,
  buildPayslipData,
  emailPayslips,
  getMockPayslipData,
  overlayEmployeeOnPayslipData,
  overlayCompanyOnPayslipData,
  standardPayslipData,
  minimalPayslipData,
  heavyLineItemsPayslipData,
  zeroNetPayPayslipData,
};
