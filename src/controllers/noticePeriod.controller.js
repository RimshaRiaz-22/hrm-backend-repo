const { sendSuccess, sendError } = require('../utils/apiResponse');
const noticePeriodService = require('../services/noticePeriod.service');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}

async function listNoticePeriods(req, res) {
  try {
    const result = await noticePeriodService.listNoticePeriods(req.authUser, req.query);
    return handleServiceResult(res, result, 'Notice periods fetched successfully.');
  } catch (error) {
    console.error('List notice periods error:', error);
    return sendError(res, 500, 'Something went wrong while fetching notice periods.');
  }
}

async function listHrExitAlerts(req, res) {
  try {
    const result = await noticePeriodService.listHrExitAlerts(req.authUser, req.query);
    return handleServiceResult(res, result, 'Exit alerts fetched successfully.');
  } catch (error) {
    console.error('List HR exit alerts error:', error);
    return sendError(res, 500, 'Something went wrong while fetching exit alerts.');
  }
}

async function waiveNoticePeriod(req, res) {
  try {
    const result = await noticePeriodService.waiveNoticePeriod(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'Notice period waived successfully.');
  } catch (error) {
    console.error('Waive notice period error:', error);
    return sendError(res, 500, 'Something went wrong while waiving the notice period.');
  }
}

module.exports = {
  listNoticePeriods,
  listHrExitAlerts,
  waiveNoticePeriod,
};
