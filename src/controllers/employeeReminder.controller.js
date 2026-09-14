const { sendSuccess, sendError } = require('../utils/apiResponse');
const employeeReminderService = require('../services/employeeReminder.service');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}

async function listEmployeeReminders(req, res) {
  try {
    const result = await employeeReminderService.listEmployeeReminders(req.authUser, req.query);
    return handleServiceResult(res, result, 'Employee reminders fetched successfully.');
  } catch (error) {
    console.error('List employee reminders error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee reminders.');
  }
}

module.exports = {
  listEmployeeReminders,
};
