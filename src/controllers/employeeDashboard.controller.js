const employeeDashboardService = require('../services/employeeDashboard.service');
const { getAuthenticatedEmployeeContext } = require('../services/documentAuth.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

async function resolveEmployee(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth;
}

/** GET /api/v1/employee/dashboard/status-today */
async function getEmployeeStatusToday(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  try {
    const result = await employeeDashboardService.getEmployeeStatusToday(auth, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee dashboard status today fetched successfully.', result.data);
  } catch (error) {
    console.error('getEmployeeStatusToday error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee dashboard status today.');
  }
}

/** GET /api/v1/employee/dashboard/leave-balances */
async function getEmployeeLeaveBalances(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  try {
    const result = await employeeDashboardService.getEmployeeLeaveBalances(auth, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee dashboard leave balances fetched successfully.', result.data);
  } catch (error) {
    console.error('getEmployeeLeaveBalances error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee dashboard leave balances.');
  }
}

/** GET /api/v1/employee/dashboard/pending-requests */
async function getEmployeePendingRequests(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  try {
    const result = await employeeDashboardService.getEmployeePendingRequests(auth);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee dashboard pending requests fetched successfully.', result.data);
  } catch (error) {
    console.error('getEmployeePendingRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee dashboard pending requests.');
  }
}

/** GET /api/v1/employee/dashboard/attendance-month */
async function getEmployeeAttendanceMonth(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  try {
    const result = await employeeDashboardService.getEmployeeAttendanceMonth(auth, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee dashboard attendance month fetched successfully.', result.data);
  } catch (error) {
    console.error('getEmployeeAttendanceMonth error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee dashboard attendance month.');
  }
}

module.exports = {
  getEmployeeStatusToday,
  getEmployeeLeaveBalances,
  getEmployeePendingRequests,
  getEmployeeAttendanceMonth,
};
