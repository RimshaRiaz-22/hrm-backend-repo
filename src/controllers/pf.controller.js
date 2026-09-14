const { sendSuccess, sendError } = require('../utils/apiResponse');
const pfBalanceService = require('../services/pfBalance.service');
const pfTemporaryService = require('../services/pfTemporaryRequest.service');
const pfPermanentService = require('../services/pfPermanentRequest.service');
const pfRecoveryService = require('../services/pfRecovery.service');
const { getEmployeeIdFromAuth } = require('../utils/employeeAuth');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}

async function getMyBalance(req, res) {
  try {
    const employeeId = await getEmployeeIdFromAuth(req.authUser);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }
    const result = await pfBalanceService.getEmployeePfBalance(employeeId);
    return handleServiceResult(res, result, 'PF balance fetched successfully.');
  } catch (error) {
    console.error('Get my PF balance error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF balance.');
  }
}

async function getEmployeeBalance(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return sendError(res, 400, 'Invalid employee id.');
    }
    const result = await pfBalanceService.getEmployeePfBalanceForAdmin(
      req.authUser,
      employeeId
    );
    return handleServiceResult(res, result, 'PF balance fetched successfully.');
  } catch (error) {
    console.error('Get employee PF balance error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF balance.');
  }
}

async function listAccounts(req, res) {
  try {
    const result = await pfBalanceService.listPfAccounts(req.authUser, req.query);
    return handleServiceResult(res, result, 'PF accounts fetched successfully.');
  } catch (error) {
    console.error('List PF accounts error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF accounts.');
  }
}

async function enrollAccount(req, res) {
  try {
    const result = await pfBalanceService.enrollPfAccount(req.authUser, req.body);
    return handleServiceResult(res, result, 'PF account enabled successfully.', 201);
  } catch (error) {
    console.error('Enroll PF account error:', error);
    return sendError(res, 500, 'Something went wrong while enabling PF account.');
  }
}

async function updateAccountRates(req, res) {
  try {
    const result = await pfBalanceService.updatePfAccountRates(
      req.authUser,
      req.params.employeeId,
      req.body
    );
    return handleServiceResult(res, result, 'PF contribution rates updated successfully.');
  } catch (error) {
    console.error('Update PF account rates error:', error);
    return sendError(res, 500, 'Something went wrong while updating PF contribution rates.');
  }
}

async function processContributions(req, res) {
  try {
    const result = await pfBalanceService.processMonthlyContributions(req.authUser, req.body);
    return handleServiceResult(res, result, 'PF contributions processed successfully.');
  } catch (error) {
    console.error('Process PF contributions error:', error);
    return sendError(res, 500, 'Something went wrong while processing PF contributions.');
  }
}

async function previewPfTemporary(req, res) {
  try {
    const result = await pfTemporaryService.previewPfTemporary(req.authUser, req.body);
    return handleServiceResult(res, result, 'PF temporary preview calculated.');
  } catch (error) {
    console.error('Preview PF temporary error:', error);
    return sendError(res, 500, 'Something went wrong while calculating PF temporary preview.');
  }
}

async function previewPfPermanent(req, res) {
  try {
    const result = await pfPermanentService.previewPfPermanent(req.authUser, req.body);
    return handleServiceResult(res, result, 'PF permanent preview calculated.');
  } catch (error) {
    console.error('Preview PF permanent error:', error);
    return sendError(res, 500, 'Something went wrong while calculating PF permanent preview.');
  }
}

async function listRecoveries(req, res) {
  try {
    const result = await pfRecoveryService.listPfRecoveries(req.authUser, req.query);
    return handleServiceResult(res, result, 'PF recoveries fetched successfully.');
  } catch (error) {
    console.error('List PF recoveries error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF recoveries.');
  }
}

async function listMyRecoveries(req, res) {
  try {
    const result = await pfRecoveryService.listMyPfRecoveries(req.authUser, req.query);
    return handleServiceResult(res, result, 'PF recoveries fetched successfully.');
  } catch (error) {
    console.error('List my PF recoveries error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF recoveries.');
  }
}

async function getRecovery(req, res) {
  try {
    const result = await pfRecoveryService.getPfRecoveryById(req.authUser, req.params.id);
    return handleServiceResult(res, result, 'PF recovery fetched successfully.');
  } catch (error) {
    console.error('Get PF recovery error:', error);
    return sendError(res, 500, 'Something went wrong while fetching PF recovery.');
  }
}

module.exports = {
  getMyBalance,
  getEmployeeBalance,
  listAccounts,
  enrollAccount,
  updateAccountRates,
  processContributions,
  previewPfTemporary,
  previewPfPermanent,
  listRecoveries,
  listMyRecoveries,
  getRecovery,
};
