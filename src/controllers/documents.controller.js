const documentsService = require('../services/documents.service');
const { getAuthenticatedEmployeeContext, resolveDocumentCompanyScope } = require('../services/documentAuth.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

async function getDocumentHrAuth(req) {
  return resolveDocumentCompanyScope(req.authUser, {
    company_id: req.query?.company_id ?? req.body?.company_id,
  });
}

async function getDocumentManagement(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.listDocumentManagement(auth.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document management data fetched successfully.', result);
  } catch (error) {
    console.error('getDocumentManagement error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document management data.');
  }
}

async function createDocumentRequest(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.createHrDocumentRequest(
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Document request sent to employee successfully.', result);
  } catch (error) {
    console.error('createDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while creating document request.');
  }
}

async function createBulkDocumentRequests(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.createBulkHrDocumentRequests(
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Document requests sent successfully.', result);
  } catch (error) {
    console.error('createBulkDocumentRequests error:', error);
    return sendError(res, 500, 'Something went wrong while creating document requests.');
  }
}

async function createCompanyUpload(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.createCompanyUploadedDocument(
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Document uploaded successfully.', result);
  } catch (error) {
    console.error('createCompanyUpload error:', error);
    return sendError(res, 500, 'Something went wrong while uploading document.');
  }
}

async function getRequiredDocuments(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.listEmployeeRequiredDocuments(
      auth.employeeId,
      auth.companyId,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Required documents fetched successfully.', result);
  } catch (error) {
    console.error('getRequiredDocuments error:', error);
    return sendError(res, 500, 'Something went wrong while fetching required documents.');
  }
}

async function getCompanyDocuments(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.listEmployeeCompanyDocuments(
      auth.employeeId,
      auth.companyId,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Company documents fetched successfully.', result);
  } catch (error) {
    console.error('getCompanyDocuments error:', error);
    return sendError(res, 500, 'Something went wrong while fetching company documents.');
  }
}

async function listCompanyUploadedDocuments(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  try {
    const result = await documentsService.listCompanyUploadedDocuments(auth.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Company documents fetched successfully.', result);
  } catch (error) {
    console.error('listCompanyUploadedDocuments error:', error);
    return sendError(res, 500, 'Something went wrong while fetching company documents.');
  }
}

async function uploadDocument(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const result = await documentsService.uploadEmployeeDocument(
      requirementId,
      auth.employeeId,
      auth.companyId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document uploaded successfully.', result);
  } catch (error) {
    console.error('uploadDocument error:', error);
    return sendError(res, 500, 'Something went wrong while uploading document.');
  }
}

async function approveDocument(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const result = await documentsService.approveDocument(requirementId, auth.companyId, auth.userId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document approved successfully.', result);
  } catch (error) {
    console.error('approveDocument error:', error);
    return sendError(res, 500, 'Something went wrong while approving document.');
  }
}

async function updateDocumentRequest(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const result = await documentsService.updateHrDocumentRequest(
      requirementId,
      auth.companyId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document request updated successfully.', result);
  } catch (error) {
    console.error('updateDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while updating document request.');
  }
}

async function cancelDocumentRequest(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const result = await documentsService.cancelHrDocumentRequest(requirementId, auth.companyId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document request cancelled successfully.', result);
  } catch (error) {
    console.error('cancelDocumentRequest error:', error);
    return sendError(res, 500, 'Something went wrong while cancelling document request.');
  }
}

async function rejectDocument(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const result = await documentsService.rejectDocument(
      requirementId,
      auth.companyId,
      auth.userId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Document rejected successfully.', result);
  } catch (error) {
    console.error('rejectDocument error:', error);
    return sendError(res, 500, 'Something went wrong while rejecting document.');
  }
}

async function getDocumentById(req, res) {
  const auth = await getDocumentHrAuth(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const requirementId = documentsService.parsePositiveInt(req.params.id);
  if (!requirementId) return sendError(res, 400, 'Document id must be a positive integer.');
  try {
    const document = await documentsService.fetchRequirementById(requirementId, auth.companyId);
    if (!document) return sendError(res, 404, 'Document not found.');
    return sendSuccess(res, 200, 'Document fetched successfully.', { document });
  } catch (error) {
    console.error('getDocumentById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document.');
  }
}

module.exports = {
  getDocumentManagement,
  createDocumentRequest,
  createBulkDocumentRequests,
  createCompanyUpload,
  updateDocumentRequest,
  cancelDocumentRequest,
  getRequiredDocuments,
  getCompanyDocuments,
  listCompanyUploadedDocuments,
  uploadDocument,
  approveDocument,
  rejectDocument,
  getDocumentById,
};
