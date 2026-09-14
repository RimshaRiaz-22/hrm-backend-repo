const employeePayslipService = require('../services/employeePayslip.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message] = result.error;
  sendError(res, status, message);
  return true;
}

/** GET /api/v1/employee/payslips/me */
async function listMyPayslips(req, res) {
  try {
    const result = await employeePayslipService.listMyPayslips(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payslips fetched successfully.', result);
  } catch (error) {
    console.error('listMyPayslips error:', error);
    return sendError(res, 500, 'Something went wrong while fetching payslips.');
  }
}

/** GET /api/v1/employee/payslips/me/:runId */
async function getMyPayslipDetail(req, res) {
  try {
    const result = await employeePayslipService.getMyPayslipDetail(req.authUser, req.params.runId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Payslip fetched successfully.', result);
  } catch (error) {
    console.error('getMyPayslipDetail error:', error);
    return sendError(res, 500, 'Something went wrong while fetching payslip details.');
  }
}

/** GET /api/v1/employee/payslips/me/:runId/pdf */
async function downloadMyPayslipPdf(req, res) {
  try {
    const result = await employeePayslipService.getMyPayslipPdf(req.authUser, req.params.runId);
    if (handleServiceError(res, result)) return;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.pdfBuffer);
  } catch (error) {
    console.error('downloadMyPayslipPdf error:', error);
    return sendError(res, 500, 'Failed to generate payslip PDF.');
  }
}

module.exports = {
  listMyPayslips,
  getMyPayslipDetail,
  downloadMyPayslipPdf,
};
