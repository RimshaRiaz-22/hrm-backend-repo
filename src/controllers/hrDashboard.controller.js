const hrDashboardService = require('../services/hrDashboard.service');
const { getAuthenticatedCompanyAdmin } = require('../services/leavePolicy.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');


function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}
async function resolveHrAdmin(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth.admin;
}
/** GET /api/v1/hr/dashboard/summary */
async function getHrDashboardSummary(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrDashboardSummary(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard summary fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrDashboardSummary error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard summary.');
  }
}

/** GET /api/v1/hr/dashboard/action-required */
async function getHrActionRequired(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrActionRequired(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard action required fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrActionRequired error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard action required.');
  }
}

/** GET /api/v1/hr/dashboard/attendance-snapshot */
async function getHrAttendanceSnapshot(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrAttendanceSnapshot(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard attendance snapshot fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrAttendanceSnapshot error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard attendance snapshot.');
  }
}

/** GET /api/v1/hr/dashboard/upcoming */
async function getHrUpcoming(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrUpcoming(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard upcoming events fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrUpcoming error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard upcoming events.');
  }
}

/** GET /api/v1/hr/dashboard/leave-overview */
async function getHrLeaveOverview(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrLeaveOverview(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard leave overview fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrLeaveOverview error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard leave overview.');
  }
}

/** GET /api/v1/hr/dashboard/workforce */
async function getHrWorkforce(req, res) {
  const admin = await resolveHrAdmin(req, res);
  if (!admin) return;

  try {
    const result = await hrDashboardService.getHrWorkforce(
      Number(admin.company_id),
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'HR dashboard workforce fetched successfully.', result.data);
  } catch (error) {
    console.error('getHrWorkforce error:', error);
    return sendError(res, 500, 'Something went wrong while fetching HR dashboard workforce.');
  }
}

module.exports = {
  getHrDashboardSummary,
  getHrActionRequired,
  getHrAttendanceSnapshot,
  getHrUpcoming,
  getHrLeaveOverview,
  getHrWorkforce,
};
