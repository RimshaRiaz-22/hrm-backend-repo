const documentRequestService = require('../services/documentRequest.service');
const { getAuthenticatedEmployeeContext, getHrReviewerContext } = require('../services/documentAuth.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

async function createDocumentRequest(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentRequestService.createDocumentRequest(
      auth.employeeId,
      auth.companyId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Document request submitted successfully.', result);
  } catch (error) {
    console.error('createDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while submitting document request.');
  }
}

async function getMyDocumentRequests(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentRequestService.listMyDocumentRequests(
      auth.employeeId,
      auth.companyId,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document requests fetched successfully.', result);
  } catch (error) {
    console.error('getMyDocumentRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document requests.');
  }
}

async function getHrDocumentRequests(req, res) {
  const auth = await getHrReviewerContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentRequestService.listHrDocumentRequests(auth.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document requests fetched successfully.', result);
  } catch (error) {
    console.error('getHrDocumentRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document requests.');
  }
}

async function getHrDocumentRequestById(req, res) {
  const auth = await getHrReviewerContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const document_request = await documentRequestService.fetchDocumentRequestById(requestId, auth.companyId);
    if (!document_request) return sendError(res, 404, 'Document request not found.');
    return sendSuccess(res, 200, 'Document request fetched successfully.', { document_request });
  } catch (error) {
    console.error('getHrDocumentRequestById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document request.');
  }
}

async function uploadFinalDocument(req, res) {
  const auth = await getHrReviewerContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const result = await documentRequestService.uploadFinalDocument(
      requestId,
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Final document uploaded successfully. Employee can download it now.', result);
  } catch (error) {
    console.error('uploadFinalDocument error:', error);
    return sendError(res, 500, 'Something went wrong while uploading final document.');
  }
}

async function cancelDocumentRequest(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const result = await documentRequestService.cancelDocumentRequest(
      requestId,
      auth.employeeId,
      auth.companyId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document request cancelled successfully.', result);
  } catch (error) {
    console.error('cancelDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while cancelling document request.');
  }
}

async function rejectDocumentRequest(req, res) {
  const auth = await getHrReviewerContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const result = await documentRequestService.rejectDocumentRequest(
      requestId,
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document request rejected successfully.', result);
  } catch (error) {
    console.error('rejectDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while rejecting document request.');
  }
}

async function getTeamDocumentRequests(req, res) {
  try {
    const result = await documentRequestService.listTeamDocumentRequests(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team document requests fetched successfully.', result);
  } catch (error) {
    console.error('getTeamDocumentRequests error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team document requests.');
  }
}

async function getTeamDocumentRequestById(req, res) {
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const result = await documentRequestService.getTeamDocumentRequestById(req.authUser, requestId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team document request fetched successfully.', result);
  } catch (error) {
    console.error('getTeamDocumentRequestById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching team document request.');
  }
}

async function updateTeamDocumentRequestStatus(req, res) {
  const requestId = documentRequestService.parsePositiveInt(req.params.id);
  if (!requestId) return sendError(res, 400, 'Document request id must be a positive integer.');
  try {
    const result = await documentRequestService.updateTeamDocumentRequestStatus(
      req.authUser,
      requestId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Team document request updated successfully.', result);
  } catch (error) {
    console.error('updateTeamDocumentRequestStatus error:', error);
    return sendError(res, 500, 'Something went wrong while updating team document request.');
  }
}

module.exports = {
  createDocumentRequest,
  getMyDocumentRequests,
  getHrDocumentRequests,
  getHrDocumentRequestById,
  uploadFinalDocument,
  rejectDocumentRequest,
  cancelDocumentRequest,
  getTeamDocumentRequests,
  getTeamDocumentRequestById,
  updateTeamDocumentRequestStatus,
};
