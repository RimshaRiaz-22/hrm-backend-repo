const payslipService = require('../services/payslip.service');
const { buildPayslipDataForEmployee } = require('../services/payslip/payslipPreviewEmployee');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function getPreviewRequestInput(req) {
  return { ...req.query, ...(req.body || {}) };
}

async function buildPreviewPayslipContext(req) {
  const source = getPreviewRequestInput(req);
  const variant = String(source.variant || 'standard').trim().toLowerCase();
  let payslipData = payslipService.getMockPayslipData(variant);
  let to = source.to ? String(source.to).trim() : null;
  let passwordProtected = String(source.password_protected || 'false').toLowerCase() === 'true';
  let password = source.password ? String(source.password) : null;
  const passwordHint = source.password_hint ? String(source.password_hint) : null;

  if (source.employee_id) {
    const resolved = await buildPayslipDataForEmployee(req.authUser, source.employee_id, {
      periodMonth: source.period_month ? String(source.period_month) : undefined,
    });
    if (resolved.error) {
      return { error: resolved.error };
    }

    payslipData = resolved.payslipData;
    to = resolved.to;
    if (resolved.passwordProtected) {
      passwordProtected = true;
      if (!password) password = 'test1234';
    }
  } else {
    const overlay = {};
    if (source.employee_name) overlay.name = String(source.employee_name);
    if (source.employee_code) overlay.employee_code = String(source.employee_code);
    if (source.designation) overlay.designation = String(source.designation);
    if (source.department) overlay.department = String(source.department);
    if (source.employee_email || source.email) {
      overlay.email = String(source.employee_email || source.email);
    }

    if (Object.keys(overlay).length > 0) {
      payslipData = payslipService.overlayEmployeeOnPayslipData(payslipData, overlay);
    }

    if (!to) {
      to = payslipData.employee?.email ? String(payslipData.employee.email).trim() : null;
    }
  }

  return {
    payslipData,
    password,
    passwordProtected,
    passwordHint,
    to,
  };
}

/** GET /api/v1/payroll/payslips/preview */
async function previewPayslipPdf(req, res) {
  try {
    const context = await buildPreviewPayslipContext(req);
    if (context.error) {
      const [status, message] = context.error;
      return sendError(res, status, message);
    }

    const { payslipData, password } = context;
    const pdfBuffer = await payslipService.generatePayslipPdf(payslipData, { password });
    const filename = payslipService.buildPayslipFilename(payslipData);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('previewPayslipPdf error:', error);
    return sendError(res, 500, 'Failed to generate payslip preview.');
  }
}

/** GET /api/v1/payroll/payslips/preview/email */
async function previewPayslipEmail(req, res) {
  try {
    const context = await buildPreviewPayslipContext(req);
    if (context.error) {
      const [status, message] = context.error;
      return sendError(res, status, message);
    }

    const { payslipData, passwordProtected, passwordHint } = context;
    const email = payslipService.buildPayslipEmailContent(payslipData, {
      passwordProtected,
      passwordHint,
    });

    return sendSuccess(res, 200, 'Payslip email preview generated.', email);
  } catch (error) {
    console.error('previewPayslipEmail error:', error);
    return sendError(res, 500, 'Failed to build payslip email preview.');
  }
}

/** POST /api/v1/payroll/payslips/preview/send */
async function previewSendPayslipEmail(req, res) {
  try {
    const context = await buildPreviewPayslipContext(req);
    if (context.error) {
      const [status, message] = context.error;
      return sendError(res, status, message);
    }

    const { payslipData, password, passwordProtected, passwordHint, to } = context;
    if (!to) {
      return sendError(res, 400, 'Employee work email is not set. Add a work email on the employee profile first.');
    }
    const effectivePassword = password || (passwordProtected ? 'test1234' : null);
    const effectiveHint =
      passwordHint ||
      (effectivePassword === 'test1234'
        ? 'Use password test1234 to open the attached PDF.'
        : effectivePassword
          ? 'Use the password provided by your HR department to open the attached PDF.'
          : null);

    const result = await payslipService.sendPayslipEmail(payslipData, {
      to,
      password: effectivePassword,
      passwordProtected: Boolean(effectivePassword),
      passwordHint: effectiveHint,
    });

    if (!result.sent) {
      return sendError(res, 400, result.reason || 'Failed to send payslip email.');
    }

    return sendSuccess(res, 200, 'Payslip email sent with PDF attachment.', {
      to: result.to,
      subject: result.subject,
      filename: result.filename,
      attachment_bytes: result.attachment_bytes,
      message_id: result.message_id || null,
    });
  } catch (error) {
    console.error('previewSendPayslipEmail error:', error);
    return sendError(res, 500, 'Failed to send payslip email.');
  }
}

module.exports = {
  previewPayslipPdf,
  previewPayslipEmail,
  previewSendPayslipEmail,
};
