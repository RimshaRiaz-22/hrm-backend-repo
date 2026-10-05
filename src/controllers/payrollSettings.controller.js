const payrollScheduleService = require('../services/payrollSchedule.service');
const payElementService = require('../services/payElement.service');
const salaryTemplateService = require('../services/salaryTemplate.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

async function resolveCompanyAdmin(req, res) {
  const auth = await payElementService.getAuthenticatedCompanyAdmin(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth.admin;
}

/** POST /api/v1/payroll/settings/schedules */
async function createSchedule(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payrollScheduleService.create(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Payroll schedule created successfully.', result);
  } catch (error) {
    console.error('createSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while creating payroll schedule.');
  }
}

/** GET /api/v1/payroll/settings/schedules */
async function listSchedules(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payrollScheduleService.list(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll schedules fetched successfully.', result);
  } catch (error) {
    console.error('listSchedules error:', error);
    return sendError(res, 500, 'Something went wrong while fetching payroll schedules.');
  }
}

/** PATCH /api/v1/payroll/settings/schedules/:id */
async function updateSchedule(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const scheduleId = payrollScheduleService.parsePositiveInt(req.params.id);
  if (!scheduleId) return sendError(res, 400, 'Schedule id must be a positive integer.');

  try {
    const result = await payrollScheduleService.update(req.authUser, scheduleId, req.body || {});
    if (handleServiceError(res, result)) return;
    const message = result.warning
      ? 'Payroll schedule updated successfully.'
      : 'Payroll schedule updated successfully.';
    return sendSuccess(res, 200, message, result);
  } catch (error) {
    console.error('updateSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while updating payroll schedule.');
  }
}

/** DELETE /api/v1/payroll/settings/schedules/:id */
async function deleteSchedule(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const scheduleId = payrollScheduleService.parsePositiveInt(req.params.id);
  if (!scheduleId) return sendError(res, 400, 'Schedule id must be a positive integer.');

  try {
    const result = await payrollScheduleService.remove(req.authUser, scheduleId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll schedule deleted successfully.', result);
  } catch (error) {
    console.error('deleteSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while deleting payroll schedule.');
  }
}

// ============ ALLOWANCES ============

/** POST /api/v1/payroll/settings/allowances */
async function createAllowance(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.createAllowance(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Allowance created successfully.', result);
  } catch (error) {
    console.error('createAllowance error:', error);
    return sendError(res, 500, 'Something went wrong while creating allowance.');
  }
}

/** GET /api/v1/payroll/settings/allowances */
async function listAllowances(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.listAllowances(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Allowances fetched successfully.', result);
  } catch (error) {
    console.error('listAllowances error:', error);
    return sendError(res, 500, 'Something went wrong while fetching allowances.');
  }
}

/** PATCH /api/v1/payroll/settings/allowances/:id */
async function updateAllowance(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Allowance id must be a positive integer.');

  try {
    const result = await payElementService.updateAllowance(req.authUser, id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Allowance updated successfully.', result);
  } catch (error) {
    console.error('updateAllowance error:', error);
    return sendError(res, 500, 'Something went wrong while updating allowance.');
  }
}

/** DELETE /api/v1/payroll/settings/allowances/:id */
async function deleteAllowance(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Allowance id must be a positive integer.');

  try {
    const result = await payElementService.deleteAllowance(req.authUser, id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Allowance deleted successfully.', result);
  } catch (error) {
    console.error('deleteAllowance error:', error);
    return sendError(res, 500, 'Something went wrong while deleting allowance.');
  }
}

/** POST /api/v1/payroll/allowances/import */
async function importAllowances(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.bulkImportAllowances(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Allowances imported successfully.', result);
  } catch (error) {
    console.error('importAllowances error:', error);
    return sendError(res, 500, 'Something went wrong while importing allowances.');
  }
}

// ============ DEDUCTIONS ============

/** POST /api/v1/payroll/settings/deductions */
async function createDeduction(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.createDeduction(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Deduction created successfully.', result);
  } catch (error) {
    console.error('createDeduction error:', error);
    return sendError(res, 500, 'Something went wrong while creating deduction.');
  }
}

/** GET /api/v1/payroll/settings/deductions */
async function listDeductions(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.listDeductions(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Deductions fetched successfully.', result);
  } catch (error) {
    console.error('listDeductions error:', error);
    return sendError(res, 500, 'Something went wrong while fetching deductions.');
  }
}

/** PATCH /api/v1/payroll/settings/deductions/:id */
async function updateDeduction(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Deduction id must be a positive integer.');

  try {
    const result = await payElementService.updateDeduction(req.authUser, id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Deduction updated successfully.', result);
  } catch (error) {
    console.error('updateDeduction error:', error);
    return sendError(res, 500, 'Something went wrong while updating deduction.');
  }
}

/** DELETE /api/v1/payroll/settings/deductions/:id */
async function deleteDeduction(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Deduction id must be a positive integer.');

  try {
    const result = await payElementService.deleteDeduction(req.authUser, id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Deduction deleted successfully.', result);
  } catch (error) {
    console.error('deleteDeduction error:', error);
    return sendError(res, 500, 'Something went wrong while deleting deduction.');
  }
}

/** POST /api/v1/payroll/deductions/import */
async function importDeductions(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.bulkImportDeductions(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Deductions imported successfully.', result);
  } catch (error) {
    console.error('importDeductions error:', error);
    return sendError(res, 500, 'Something went wrong while importing deductions.');
  }
}

// ============ CONTRIBUTIONS ============

/** POST /api/v1/payroll/settings/contributions */
async function createContribution(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.createContribution(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Contribution created successfully.', result);
  } catch (error) {
    console.error('createContribution error:', error);
    return sendError(res, 500, 'Something went wrong while creating contribution.');
  }
}

/** GET /api/v1/payroll/settings/contributions */
async function listContributions(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.listContributions(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Contributions fetched successfully.', result);
  } catch (error) {
    console.error('listContributions error:', error);
    return sendError(res, 500, 'Something went wrong while fetching contributions.');
  }
}

/** PATCH /api/v1/payroll/settings/contributions/:id */
async function updateContribution(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Contribution id must be a positive integer.');

  try {
    const result = await payElementService.updateContribution(req.authUser, id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Contribution updated successfully.', result);
  } catch (error) {
    console.error('updateContribution error:', error);
    return sendError(res, 500, 'Something went wrong while updating contribution.');
  }
}

/** DELETE /api/v1/payroll/settings/contributions/:id */
async function deleteContribution(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = payElementService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Contribution id must be a positive integer.');

  try {
    const result = await payElementService.deleteContribution(req.authUser, id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Contribution deleted successfully.', result);
  } catch (error) {
    console.error('deleteContribution error:', error);
    return sendError(res, 500, 'Something went wrong while deleting contribution.');
  }
}

/** POST /api/v1/payroll/contributions/import */
async function importContributions(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await payElementService.bulkImportContributions(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Contributions imported successfully.', result);
  } catch (error) {
    console.error('importContributions error:', error);
    return sendError(res, 500, 'Something went wrong while importing contributions.');
  }
}

// ============ SALARY TEMPLATES ============

/** POST /api/v1/payroll/templates */
async function createTemplate(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await salaryTemplateService.create(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Salary template created successfully.', result);
  } catch (error) {
    console.error('createTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while creating salary template.');
  }
}

/** GET /api/v1/payroll/templates */
async function listTemplates(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await salaryTemplateService.list(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Salary templates fetched successfully.', result);
  } catch (error) {
    console.error('listTemplates error:', error);
    return sendError(res, 500, 'Something went wrong while fetching salary templates.');
  }
}

/** GET /api/v1/payroll/templates/:id */
async function getTemplate(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = salaryTemplateService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Template id must be a positive integer.');

  try {
    const result = await salaryTemplateService.get(req.authUser, id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Salary template fetched successfully.', result);
  } catch (error) {
    console.error('getTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while fetching salary template.');
  }
}

/** PATCH /api/v1/payroll/templates/:id */
async function updateTemplate(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = salaryTemplateService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Template id must be a positive integer.');

  try {
    const result = await salaryTemplateService.update(req.authUser, id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Salary template updated successfully.', result);
  } catch (error) {
    console.error('updateTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while updating salary template.');
  }
}

/** DELETE /api/v1/payroll/templates/:id */
async function deleteTemplate(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = salaryTemplateService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Template id must be a positive integer.');

  try {
    const result = await salaryTemplateService.remove(req.authUser, id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Salary template deleted successfully.', result);
  } catch (error) {
    console.error('deleteTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while deleting salary template.');
  }
}

/** POST /api/v1/payroll/templates/:id/assign-employees */
async function assignTemplateEmployees(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const id = salaryTemplateService.parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Template id must be a positive integer.');

  try {
    const result = await salaryTemplateService.assignEmployees(req.authUser, id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Salary template assigned to employees successfully.', result);
  } catch (error) {
    console.error('assignTemplateEmployees error:', error);
    return sendError(res, 500, 'Something went wrong while assigning salary template.');
  }
}

module.exports = {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  createAllowance,
  listAllowances,
  updateAllowance,
  deleteAllowance,
  importAllowances,
  createDeduction,
  listDeductions,
  updateDeduction,
  deleteDeduction,
  importDeductions,
  createContribution,
  listContributions,
  updateContribution,
  deleteContribution,
  importContributions,
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  assignTemplateEmployees,
};
