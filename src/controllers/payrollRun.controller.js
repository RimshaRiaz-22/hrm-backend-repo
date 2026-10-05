const payrollRunService = require('../services/payrollRun.service');
const payslipService = require('../services/payslip.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

async function preview(req, res) {
  try {
    const result = await payrollRunService.preview(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll preview generated successfully.', result);
  } catch (error) {
    console.error('previewPayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while previewing payroll.');
  }
}

async function create(req, res) {
  try {
    const result = await payrollRunService.create(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Payroll run created successfully.', result);
  } catch (error) {
    console.error('createPayrollRun error:', error.message);
    if (error.stack) console.error(error.stack);
    return sendError(res, 500, 'Something went wrong while creating payroll run.');
  }
}

async function list(req, res) {
  try {
    const result = await payrollRunService.list(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll runs fetched successfully.', result);
  } catch (error) {
    console.error('listPayrollRuns error:', error.message);
    if (error.stack) console.error(error.stack);
    return sendError(res, 500, 'Something went wrong while fetching payroll runs.');
  }
}

async function getOne(req, res) {
  try {
    const result = await payrollRunService.getById(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll run fetched successfully.', result);
  } catch (error) {
    console.error('getPayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while fetching payroll run.');
  }
}

async function getSkipped(req, res) {
  try {
    const result = await payrollRunService.getSkipped(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Skipped employees fetched successfully.', result);
  } catch (error) {
    console.error('getSkippedPayrollEmployees error:', error);
    return sendError(res, 500, 'Something went wrong while fetching skipped employees.');
  }
}

async function listEmployees(req, res) {
  try {
    const result = await payrollRunService.listEmployees(req.authUser, req.params.id, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Run employees fetched successfully.', result);
  } catch (error) {
    console.error('listPayrollRunEmployees error:', error);
    return sendError(res, 500, 'Something went wrong while fetching run employees.');
  }
}
async function getEmployee(req, res) {
  try {
    const result = await payrollRunService.getEmployee(
      req.authUser,
      req.params.id,
      req.params.employeeId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Run employee fetched successfully.', result);
  } catch (error) {
    console.error('getPayrollRunEmployee error:', error);
    return sendError(res, 500, 'Something went wrong while fetching run employee.');
  }
}
async function updateEmployee(req, res) {
  try {
    const result = await payrollRunService.updateEmployee(
      req.authUser,
      req.params.id,
      req.params.employeeId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Run employee updated successfully.', result);
  } catch (error) {
    console.error('updatePayrollRunEmployee error:', error);
    return sendError(res, 500, 'Something went wrong while updating run employee.');
  }
}

async function bulkUpdate(req, res) {
  try {
    const result = await payrollRunService.bulkUpdate(req.authUser, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Bulk update applied successfully.', result);
  } catch (error) {
    console.error('bulkUpdatePayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while applying bulk update.');
  }
}

async function importRows(req, res) {
  try {
    const result = await payrollRunService.importRows(req.authUser, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll import applied successfully.', result);
  } catch (error) {
    console.error('importPayrollRun error:', error.message);
    if (error.stack) console.error(error.stack);
    return sendError(res, 500, 'Something went wrong while importing payroll data.');
  }
}

async function downloadImportTemplate(req, res) {
  try {
    const result = await payrollRunService.buildImportTemplate(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.buffer);
  } catch (error) {
    console.error('downloadPayrollImportTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while generating the import template.');
  }
}

async function validateImportRows(req, res) {
  try {
    const result = await payrollRunService.validateImportRows(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll import validated successfully.', result);
  } catch (error) {
    console.error('validatePayrollImport error:', error);
    return sendError(res, 500, 'Something went wrong while validating payroll import data.');
  }
}

async function transition(req, res) {
  try {
    const result = await payrollRunService.transition(
      req.authUser,
      req.params.id,
      req.body?.action
    );
    if (handleServiceError(res, result)) return;

    if (result.action === 'close') {
      try {
        const payslipEmails = await payslipService.emailPayslips(
          req.authUser,
          req.params.id,
          {}
        );
        result.payslip_emails = payslipEmails.error
          ? {
              sent: [],
              failed: [],
              error: payslipEmails.error[1],
            }
          : payslipEmails;
      } catch (emailError) {
        console.error('automaticPayslipEmail error:', emailError);
        result.payslip_emails = {
          sent: [],
          failed: [],
          error: 'Payroll was closed, but automatic payslip emailing failed.',
        };
      }
    }

    let message = 'Payroll run status updated successfully.';
    if (result.action === 'close' && result.pf_contributions) {
      const pfResult = result.pf_contributions;
      message = `Payroll run closed. PF posted for ${pfResult.processed_count} employee(s)`;
      if (pfResult.skipped_count > 0) {
        message += `; ${pfResult.skipped_count} skipped.`;
      } else {
        message += '.';
      }
    }
    if (result.action === 'close' && result.payslip_emails) {
      const sentCount = result.payslip_emails.sent?.length || 0;
      const failedCount = result.payslip_emails.failed?.length || 0;
      if (result.payslip_emails.error) {
        message += ` ${result.payslip_emails.error}`;
      } else {
        message += ` Payslips emailed to ${sentCount} employee(s)`;
        message += failedCount > 0 ? `; ${failedCount} failed.` : '.';
      }
    }
    return sendSuccess(res, 200, message, result);
  } catch (error) {
    console.error('transitionPayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while updating payroll run status.');
  }
}

async function exportSheet(req, res) {
  try {
    const result = await payrollRunService.exportSheet(req.authUser, req.params.id, req.query || {});
    if (handleServiceError(res, result)) return;

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.buffer);
  } catch (error) {
    console.error('exportPayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while exporting payroll run.');
  }
}

async function emailPayslips(req, res) {
  try {
    const result = await payslipService.emailPayslips(req.authUser, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payslip emails processed successfully.', result);
  } catch (error) {
    console.error('emailPayslips error:', error);
    return sendError(res, 500, 'Something went wrong while emailing payslips.');
  }
}

async function remove(req, res) {
  try {
    const result = await payrollRunService.remove(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll run deleted successfully.', result);
  } catch (error) {
    console.error('deletePayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while deleting payroll run.');
  }
}

async function rebuildDraft(req, res) {
  try {
    const result = await payrollRunService.rebuildDraft(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(
      res,
      200,
      'Payroll run rebuilt from sources (including salary-paid expenses).',
      result
    );
  } catch (error) {
    console.error('rebuildDraftPayrollRun error:', error);
    return sendError(res, 500, 'Something went wrong while rebuilding payroll run.');
  }
}

module.exports = {
  preview,
  create,
  list,
  getOne,
  getSkipped,
  listEmployees,
  getEmployee,
  updateEmployee,
  bulkUpdate,
  downloadImportTemplate,
  validateImportRows,
  importRows,
  transition,
  exportSheet,
  emailPayslips,
  remove,
  rebuildDraft,
};
