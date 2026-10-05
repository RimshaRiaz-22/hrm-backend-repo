const payrollAssignmentService = require('../services/payrollAssignment.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

/** GET /api/v1/employees/:id/payroll */
async function getEmployeePayroll(req, res) {
  try {
    const result = await payrollAssignmentService.getProfile(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee payroll profile fetched successfully.', result);
  } catch (error) {
    console.error('getEmployeePayroll error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee payroll profile.');
  }
}

/** PATCH /api/v1/employees/:id/payroll */
async function updateEmployeePayroll(req, res) {
  try {
    const result = await payrollAssignmentService.updateProfile(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee payroll profile updated successfully.', result);
  } catch (error) {
    console.error('updateEmployeePayroll error:', error);
    return sendError(res, 500, 'Something went wrong while updating employee payroll profile.');
  }
}

/** POST /api/v1/employees/:id/payroll/elements */
async function addEmployeePayrollElement(req, res) {
  try {
    const result = await payrollAssignmentService.addElement(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Pay element added to employee successfully.', result);
  } catch (error) {
    console.error('addEmployeePayrollElement error:', error);
    return sendError(res, 500, 'Something went wrong while adding pay element.');
  }
}

/** PATCH /api/v1/employees/:id/payroll/elements/:payElementId */
async function updateEmployeePayrollElement(req, res) {
  try {
    const result = await payrollAssignmentService.updateElement(
      req.authUser,
      req.params.id,
      req.params.payElementId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee pay element updated successfully.', result);
  } catch (error) {
    console.error('updateEmployeePayrollElement error:', error);
    return sendError(res, 500, 'Something went wrong while updating pay element.');
  }
}

/** DELETE /api/v1/employees/:id/payroll/elements/:payElementId */
async function removeEmployeePayrollElement(req, res) {
  try {
    const result = await payrollAssignmentService.removeElement(
      req.authUser,
      req.params.id,
      req.params.payElementId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee pay element removed successfully.', result);
  } catch (error) {
    console.error('removeEmployeePayrollElement error:', error);
    return sendError(res, 500, 'Something went wrong while removing pay element.');
  }
}

/** POST /api/v1/payroll/assignments/bulk */
async function bulkAssignPayroll(req, res) {
  try {
    const result = await payrollAssignmentService.bulkAssign(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payroll assignments applied successfully.', result);
  } catch (error) {
    console.error('bulkAssignPayroll error:', error);
    return sendError(res, 500, 'Something went wrong while applying bulk payroll assignments.');
  }
}

/** GET /api/v1/payroll/assignments/missing-schedule */
async function listEmployeesMissingSchedule(req, res) {
  try {
    const auth = await payrollAssignmentService.getAuthenticatedCompanyAdmin(req.authUser);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const employees = await payrollAssignmentService.getEmployeesWithoutSchedule(
      Number(auth.admin.company_id)
    );
    return sendSuccess(res, 200, 'Employees without payroll schedule fetched successfully.', {
      employees,
      count: employees.length,
    });
  } catch (error) {
    console.error('listEmployeesMissingSchedule error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employees without schedule.');
  }
}

module.exports = {
  getEmployeePayroll,
  updateEmployeePayroll,
  addEmployeePayrollElement,
  updateEmployeePayrollElement,
  removeEmployeePayrollElement,
  bulkAssignPayroll,
  listEmployeesMissingSchedule,
};
