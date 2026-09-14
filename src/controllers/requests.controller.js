const { sendSuccess, sendError } = require('../utils/apiResponse');
const requestsService = require('../services/requests.service');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}
async function createRequest(req, res) {
  try {
    const result = await requestsService.createRequest(req.authUser, req.body);
    return handleServiceResult(res, result, 'Request submitted successfully.', 201);
  } catch (error) {
    console.error('Create request error:', error);
    return sendError(res, 500, 'Something went wrong while submitting the request.');
  }
}
async function getMyRequests(req, res) {
  try {
    const result = await requestsService.listMyRequests(req.authUser, req.query);
    return handleServiceResult(res, result, 'Requests fetched successfully.');
  } catch (error) {
    console.error('Get my requests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching your requests.');
  }
}

async function getPendingRequests(req, res) {
  try {
    const result = await requestsService.listPendingRequests(req.authUser, req.query);
    return handleServiceResult(res, result, 'Pending requests fetched successfully.');
  } catch (error) {
    console.error('Get pending requests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching pending requests.');
  }
}

async function getAdminRequests(req, res) {
  try {
    const result = await requestsService.listAdminRequests(req.authUser, req.query);
    return handleServiceResult(res, result, 'Requests fetched successfully.');
  } catch (error) {
    console.error('Get admin requests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching requests.');
  }
}

async function approveRequest(req, res) {
  try {
    const result = await requestsService.approveRequest(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    return handleServiceResult(res, result, 'Request approved successfully.');
  } catch (error) {
    console.error('Approve request error:', error);
    return sendError(res, 500, 'Something went wrong while approving the request.');
  }
}

async function rejectRequest(req, res) {
  try {
    const result = await requestsService.rejectRequest(
      req.authUser,
      req.params.id,
      req.body?.hr_comment
    );
    return handleServiceResult(res, result, 'Request rejected successfully.');
  } catch (error) {
    console.error('Reject request error:', error);
    return sendError(res, 500, 'Something went wrong while rejecting the request.');
  }
}

async function cancelRequest(req, res) {
  try {
    const result = await requestsService.cancelRequest(req.authUser, req.params.id);
    return handleServiceResult(res, result, 'Request cancelled successfully.');
  } catch (error) {
    console.error('Cancel request error:', error);
    return sendError(res, 500, 'Something went wrong while cancelling the request.');
  }
}

async function updateRequest(req, res) {
  try {
    const result = await requestsService.updateRequest(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'Request updated successfully.');
  } catch (error) {
    console.error('Update request error:', error);
    return sendError(res, 500, 'Something went wrong while updating the request.');
  }
}
async function previewResignation(req, res) {
  try {
    const result = await requestsService.previewResignation(req.authUser, req.query);
    return handleServiceResult(res, result, 'Resignation preview calculated.');
  } catch (error) {
    console.error('Preview resignation error:', error);
    return sendError(res, 500, 'Something went wrong while calculating resignation preview.');
  }
}

async function getTeamRequests(req, res) {
  try {
    const result = await requestsService.listTeamRequests(req.authUser, req.query);
    return handleServiceResult(res, result, 'Team requests fetched successfully.');
  } catch (error) {
    console.error('Get team requests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team requests.');
  }
}

async function getTeamRequestById(req, res) {
  try {
    const result = await requestsService.getTeamRequestById(req.authUser, req.params.id);
    return handleServiceResult(res, result, 'Team request fetched successfully.');
  } catch (error) {
    console.error('Get team request error:', error);
    return sendError(res, 500, 'Something went wrong while fetching the team request.');
  }
}

async function updateTeamRequestStatus(req, res) {
  try {
    const result = await requestsService.updateTeamRequestStatus(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    return handleServiceResult(res, result, 'Team request updated successfully.');
  } catch (error) {
    console.error('Update team request error:', error);
    return sendError(res, 500, 'Something went wrong while updating the team request.');
  }
}

async function getTeamAttendanceCorrectionRequests(req, res) {
  try {
    const result = await requestsService.listTeamAttendanceCorrectionRequests(req.authUser, req.query);
    return handleServiceResult(res, result, 'Team attendance correction requests fetched successfully.');
  } catch (error) {
    console.error('Get team attendance correction requests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team attendance correction requests.');
  }
}

async function getTeamAttendanceCorrectionRequestById(req, res) {
  try {
    const result = await requestsService.getTeamAttendanceCorrectionRequestById(req.authUser, req.params.id);
    return handleServiceResult(res, result, 'Team attendance correction request fetched successfully.');
  } catch (error) {
    console.error('Get team attendance correction request error:', error);
    return sendError(res, 500, 'Something went wrong while fetching the team attendance correction request.');
  }
}

async function updateTeamAttendanceCorrectionStatus(req, res) {
  try {
    const result = await requestsService.updateTeamAttendanceCorrectionStatus(
      req.authUser,
      req.params.id,
      req.body || {}
    );
    return handleServiceResult(res, result, 'Team attendance correction request updated successfully.');
  } catch (error) {
    console.error('Update team attendance correction request error:', error);
    return sendError(res, 500, 'Something went wrong while updating the team attendance correction request.');
  }
}

module.exports = {
  createRequest,
  getMyRequests,
  getPendingRequests,
  getAdminRequests,
  approveRequest,
  rejectRequest,
  cancelRequest,
  updateRequest,
  previewResignation,
  getTeamRequests,
  getTeamRequestById,
  updateTeamRequestStatus,
  getTeamAttendanceCorrectionRequests,
  getTeamAttendanceCorrectionRequestById,
  updateTeamAttendanceCorrectionStatus,
};
