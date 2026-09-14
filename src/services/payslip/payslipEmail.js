const { formatPeriodMonth } = require('./payslipFormat');
const { getFrontendAppUrl } = require('../email.service');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPayslipEmailContent(payslipData, options = {}) {
  if (!payslipData || typeof payslipData !== 'object') {
    throw new Error('payslipData is required.');
  }

  const employeeName = String(payslipData.employee?.name || 'Employee').trim() || 'Employee';
  const companyName = String(payslipData.company?.name || 'Your company').trim() || 'Your company';
  const companyId = payslipData.company?.id || payslipData.company?.company_id || null;
  const companyLogoUrl = payslipData.company?.logo_url || null;
  const periodLabel = formatPeriodMonth(payslipData.run?.period_month);
  const passwordProtected = Boolean(options.passwordProtected);
  const passwordHint =
    options.passwordHint != null && String(options.passwordHint).trim()
      ? String(options.passwordHint).trim()
      : null;

  const subject = `Salary Slip for ${periodLabel} - ${companyName}`;

  const greeting = `Dear ${employeeName},`;
  const intro = `Please find attached your salary slip for ${periodLabel}.`;
  const passwordLine = passwordProtected
    ? passwordHint
      ? `This PDF is password protected. ${passwordHint}`
      : 'This PDF is password protected. Please use the password provided by your HR department to open it.'
    : null;
  const closing = `Regards,\n${companyName} HR`;
  const payslipUrl = getFrontendAppUrl('/employee/payslips');

  const textParts = [greeting, '', intro];
  if (passwordLine) textParts.push('', passwordLine);
  textParts.push('', `View your payslip: ${payslipUrl}`);
  textParts.push('', closing);
  const text = textParts.join('\n');

  const htmlParts = [
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#405169;">${escapeHtml(intro)}</p>`,
  ];
  if (passwordLine) {
    htmlParts.push(
      `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#24546f;background:#edf8ff;border:1px solid #bfe8ff;border-radius:10px;padding:14px 16px;">${escapeHtml(passwordLine)}</p>`
    );
  }
  htmlParts.push(
    `<a href="${payslipUrl}" style="display:block;width:100%;box-sizing:border-box;background:#2563eb;color:#ffffff;text-decoration:none;text-align:center;padding:16px;border-radius:8px;font-size:16px;font-weight:700;margin:0 0 16px;">View Payslip</a>`
  );
  htmlParts.push(
    `<p style="margin:0;font-size:15px;line-height:1.7;color:#405169;">Regards,<br/>${escapeHtml(companyName)} HR</p>`
  );
  const html = htmlParts.join('\n');

  return {
    subject,
    text,
    html,
    companyId,
    companyName,
    companyLogoUrl,
    to: payslipData.employee?.email || null,
    attachment_filename: `payslip-${String(payslipData.run?.period_month || 'period')}.pdf`,
  };
}

module.exports = {
  buildPayslipEmailContent,
};
