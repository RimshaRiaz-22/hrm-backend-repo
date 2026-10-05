const taxCertificateService = require('../services/taxCertificate.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

async function generateAndSend(req, res) {
  try {
    const result = await taxCertificateService.generateAndSend(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Tax certificates processed successfully.', result);
  } catch (error) {
    console.error('generateTaxCertificates error:', error);
    return sendError(res, 500, 'Something went wrong while sending tax certificates.');
  }
}

async function list(req, res) {
  try {
    const result = await taxCertificateService.list(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Tax certificates fetched successfully.', result);
  } catch (error) {
    console.error('listTaxCertificates error:', error);
    return sendError(res, 500, 'Something went wrong while fetching tax certificates.');
  }
}

module.exports = {
  generateAndSend,
  list,
};
