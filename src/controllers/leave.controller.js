const leavePolicyService = require('../services/leavePolicy.service');
const leaveBalanceService = require('../services/leaveBalance.service');
const leaveRequestService = require('../services/leaveRequest.service');
const leaveApprovalWorkflowService = require('../services/leaveApprovalWorkflow.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

async function resolveCompanyAdmin(req, res) {
  const auth = await leavePolicyService.getAuthenticatedCompanyAdmin(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth.admin;
}

async function resolveEmployee(req, res) {
  const auth = await leaveBalanceService.getAuthenticatedEmployee(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth;
}

/** POST /api/v1/leaves/policies */
async function createLeavePolicy(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await leavePolicyService.createLeavePolicy(
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Leave policy created successfully.', result);
  } catch (error) {
    console.error('createLeavePolicy error:', error);
    return sendError(res, 500, 'Something went wrong while creating leave policy.');
  }
}

/** POST /api/v1/leaves/policies/import */
async function importLeavePolicies(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await leavePolicyService.bulkImportLeavePolicies(
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Leave policies imported successfully.', result);
  } catch (error) {
    console.error('importLeavePolicies error:', error);
    return sendError(res, 500, 'Something went wrong while importing leave policies.');
  }
}

/** GET /api/v1/leaves/policies */
async function getLeavePolicies(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await leavePolicyService.getLeavePolicies(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policies fetched successfully.', result);
  } catch (error) {
    console.error('getLeavePolicies error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave policies.');
  }
}

/** GET /api/v1/leaves/policies/:id */
async function getLeavePolicyById(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  try {
    const result = await leavePolicyService.getLeavePolicyById(
      policyId,
      Number(admin.company_id)
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policy fetched successfully.', result);
  } catch (error) {
    console.error('getLeavePolicyById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave policy.');
  }
}

/** PATCH /api/v1/leaves/policies/:id */
async function updateLeavePolicy(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  try {
    const result = await leavePolicyService.updateLeavePolicy(
      policyId,
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policy updated successfully.', result);
  } catch (error) {
    console.error('updateLeavePolicy error:', error);
    return sendError(res, 500, 'Something went wrong while updating leave policy.');
  }
}

/** DELETE /api/v1/leaves/policies/:id */
async function deleteLeavePolicy(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  try {
    const result = await leavePolicyService.deleteLeavePolicy(policyId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policy deleted successfully.', result);
  } catch (error) {
    console.error('deleteLeavePolicy error:', error);
    return sendError(res, 500, 'Something went wrong while deleting leave policy.');
  }
}

/** GET /api/v1/leaves/policies/:id/approval-steps */
async function getLeavePolicyApprovalSteps(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  try {
    const result = await leaveApprovalWorkflowService.getPolicyApprovalSteps(policyId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Approval workflow fetched successfully.', result);
  } catch (error) {
    console.error('getLeavePolicyApprovalSteps error:', error);
    return sendError(res, 500, 'Something went wrong while fetching the approval workflow.');
  }
}

/** PUT /api/v1/leaves/policies/:id/approval-steps — replace-all save. */
async function updateLeavePolicyApprovalSteps(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  const steps = Array.isArray(req.body?.approval_steps) ? req.body.approval_steps : req.body?.steps;

  try {
    const result = await leaveApprovalWorkflowService.replacePolicyApprovalSteps(
      policyId,
      Number(admin.company_id),
      steps
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Approval workflow updated successfully.', result);
  } catch (error) {
    console.error('updateLeavePolicyApprovalSteps error:', error);
    return sendError(res, 500, 'Something went wrong while updating the approval workflow.');
  }
}

/** GET /api/v1/leaves/policy-cycle-history — closed anniversary leave cycles. */
async function getLeavePolicyCycleHistory(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const leaveCycleService = require('../services/leaveCycle.service');
    const result = await leaveCycleService.getLeavePolicyCycleHistory(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policy cycle history fetched successfully.', result);
  } catch (error) {
    console.error('getLeavePolicyCycleHistory error:', error);
    if (error?.code === '42P01') {
      return sendError(
        res,
        500,
        'Leave policy cycle history table is missing. Please run the leave cycle SQL migration.'
      );
    }
    return sendError(res, 500, 'Something went wrong while fetching leave policy cycle history.');
  }
}

/** GET /api/v1/leaves/policies/me — active leave policies the authenticated employee is eligible for. */
async function getMyLeavePolicies(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  try {
    const result = await leavePolicyService.getMyLeavePolicies(auth.companyId, auth.employeeId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policies fetched successfully.', result);
  } catch (error) {
    console.error('getMyLeavePolicies error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave policies.');
  }
}

/** GET /api/v1/leaves/policies/me/:id — only visible while active and the employee is eligible. */
async function getMyLeavePolicyById(req, res) {
  const auth = await resolveEmployee(req, res);
  if (!auth) return;

  const policyId = leavePolicyService.parsePositiveInt(req.params.id);
  if (!policyId) return sendError(res, 400, 'Leave policy id must be a positive integer.');

  try {
    const result = await leavePolicyService.getMyLeavePolicyById(policyId, auth.companyId, auth.employeeId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave policy fetched successfully.', result);
  } catch (error) {
    console.error('getMyLeavePolicyById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave policy.');
  }
}

/** GET /api/v1/leaves/balances/me — employee's leave balances (year, leave_policy_id, search, pagination). */
async function getMyLeaveBalances(req, res) {
  try {
    const result = await leaveBalanceService.getMyLeaveBalances(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave balances fetched successfully.', result);
  } catch (error) {
    console.error('getMyLeaveBalances error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave balances.');
  }
}

/** GET /api/v1/leaves/balances */
async function getLeaveBalances(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await leaveBalanceService.getLeaveBalances(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave balances fetched successfully.', result);
  } catch (error) {
    console.error('getLeaveBalances error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave balances.');
  }
}

/** GET /api/v1/leaves/balances/:id */
async function getLeaveBalanceById(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const balanceId = leaveBalanceService.parsePositiveInt(req.params.id);
  if (!balanceId) return sendError(res, 400, 'Leave balance id must be a positive integer.');

  try {
    const result = await leaveBalanceService.getLeaveBalanceById(
      balanceId,
      Number(admin.company_id)
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave balance fetched successfully.', result);
  } catch (error) {
    console.error('getLeaveBalanceById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave balance.');
  }
}

/** PATCH /api/v1/leaves/balances/:id */
async function updateLeaveBalance(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const balanceId = leaveBalanceService.parsePositiveInt(req.params.id);
  if (!balanceId) return sendError(res, 400, 'Leave balance id must be a positive integer.');

  try {
    const result = await leaveBalanceService.updateLeaveBalance(
      balanceId,
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave balance updated successfully.', result);
  } catch (error) {
    console.error('updateLeaveBalance error:', error);
    return sendError(res, 500, 'Something went wrong while updating leave balance.');
  }
}

/** DELETE /api/v1/leaves/balances/:id */
async function deleteLeaveBalance(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const balanceId = leaveBalanceService.parsePositiveInt(req.params.id);
  if (!balanceId) return sendError(res, 400, 'Leave balance id must be a positive integer.');

  try {
    const result = await leaveBalanceService.deleteLeaveBalance(
      balanceId,
      Number(admin.company_id)
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave balance deleted successfully.', result);
  } catch (error) {
    console.error('deleteLeaveBalance error:', error);
    return sendError(res, 500, 'Something went wrong while deleting leave balance.');
  }
}

/** POST /api/v1/leaves/requests */
async function createLeaveRequest(req, res) {
  try {
    const result = await leaveRequestService.createLeaveRequest(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Leave request submitted successfully.', result);
  } catch (error) {
    console.error('createLeaveRequest error:', error);
    return sendError(res, 500, 'Something went wrong while submitting leave request.');
  }
}

/** GET /api/v1/leaves/requests/me — employee leave requests (status, from_date, to_date, search, pagination). */
async function getMyLeaveRequests(req, res) {
  try {
    const result = await leaveRequestService.getMyLeaveRequests(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave requests fetched successfully.', result);
  } catch (error) {
    console.error('getMyLeaveRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave requests.');
  }
}

/** GET /api/v1/leaves/requests/me/:id */
async function getMyLeaveRequestById(req, res) {
  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.getMyLeaveRequestById(req.authUser, requestId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave request fetched successfully.', result);
  } catch (error) {
    console.error('getMyLeaveRequestById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave request.');
  }
}

/** GET /api/v1/leaves/requests/team — line manager lists direct reports' leave requests. */
async function getTeamLeaveRequests(req, res) {
  try {
    const result = await leaveRequestService.getTeamLeaveRequests(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team leave requests fetched successfully.', result);
  } catch (error) {
    console.error('getTeamLeaveRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team leave requests.');
  }
}

/** GET /api/v1/leaves/requests/team/:id */
async function getTeamLeaveRequestById(req, res) {
  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.getTeamLeaveRequestById(req.authUser, requestId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team leave request fetched successfully.', result);
  } catch (error) {
    console.error('getTeamLeaveRequestById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team leave request.');
  }
}

/** PATCH /api/v1/leaves/requests/team/:id/status — line manager approves or rejects a pending request. */
async function updateTeamLeaveRequestStatus(req, res) {
  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.updateTeamLeaveRequestStatus(
      req.authUser,
      requestId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team leave request updated successfully.', result);
  } catch (error) {
    console.error('updateTeamLeaveRequestStatus error:', error);
    return sendError(res, 500, 'Something went wrong while updating team leave request.');
  }
}

/** GET /api/v1/leaves/requests */
async function getLeaveRequests(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await leaveRequestService.getLeaveRequests(Number(admin.company_id), req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave requests fetched successfully.', result);
  } catch (error) {
    console.error('getLeaveRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave requests.');
  }
}

/** GET /api/v1/leaves/requests/:id */
async function getLeaveRequestById(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.getLeaveRequestById(requestId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave request fetched successfully.', result);
  } catch (error) {
    console.error('getLeaveRequestById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching leave request.');
  }
}

/** PATCH /api/v1/leaves/requests/:id/status — company admin approves, rejects, or cancels a pending/manager-approved request. */
async function updateLeaveRequestStatus(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.updateLeaveRequestStatus(
      requestId,
      Number(admin.company_id),
      req.body || {},
      Number(admin.id)
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave request updated successfully.', result);
  } catch (error) {
    console.error('updateLeaveRequestStatus error:', error);
    return sendError(res, 500, 'Something went wrong while updating leave request.');
  }
}

/** PATCH /api/v1/leaves/requests/me/:id/cancel — employee cancels their own pending request. */
async function cancelMyLeaveRequest(req, res) {
  const requestId = leaveRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Leave request id must be a positive integer.');

  try {
    const result = await leaveRequestService.cancelMyLeaveRequest(req.authUser, requestId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Leave request cancelled successfully.', result);
  } catch (error) {
    console.error('cancelMyLeaveRequest error:', error);
    return sendError(res, 500, 'Something went wrong while cancelling leave request.');
  }
}

module.exports = {
  createLeavePolicy,
  importLeavePolicies,
  getMyLeavePolicies,
  getMyLeavePolicyById,
  getLeavePolicies,
  getLeavePolicyById,
  updateLeavePolicy,
  deleteLeavePolicy,
  getLeavePolicyApprovalSteps,
  updateLeavePolicyApprovalSteps,
  getLeavePolicyCycleHistory,
  getMyLeaveBalances,
  getLeaveBalances,
  getLeaveBalanceById,
  updateLeaveBalance,
  deleteLeaveBalance,
  createLeaveRequest,
  getMyLeaveRequests,
  getMyLeaveRequestById,
  getTeamLeaveRequests,
  getTeamLeaveRequestById,
  updateTeamLeaveRequestStatus,
  getLeaveRequests,
  getLeaveRequestById,
  updateLeaveRequestStatus,
  cancelMyLeaveRequest,
};
