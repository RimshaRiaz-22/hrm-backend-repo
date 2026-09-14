const holidayService = require('../services/holiday.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

async function resolveCompanyAdmin(req, res) {
  const auth = await holidayService.getAuthenticatedCompanyAdmin(req.authUser);
  if (auth.error) {
    sendError(res, auth.error[0], auth.error[1]);
    return null;
  }
  return auth.admin;
}

/** POST /api/v1/holidays/types */
async function createHolidayType(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await holidayService.createHolidayType(Number(admin.company_id), req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Holiday type created successfully.', result);
  } catch (error) {
    console.error('createHolidayType error:', error);
    return sendError(res, 500, 'Something went wrong while creating holiday type.');
  }
}

/** GET /api/v1/holidays/types */
async function getHolidayTypes(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await holidayService.getHolidayTypes(Number(admin.company_id), req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday types fetched successfully.', result);
  } catch (error) {
    console.error('getHolidayTypes error:', error);
    return sendError(res, 500, 'Something went wrong while fetching holiday types.');
  }
}

/** GET /api/v1/holidays/types/:id */
async function getHolidayTypeById(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const typeId = holidayService.parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Holiday type id must be a positive integer.');

  try {
    const result = await holidayService.getHolidayTypeById(typeId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday type fetched successfully.', result);
  } catch (error) {
    console.error('getHolidayTypeById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching holiday type.');
  }
}

/** PATCH /api/v1/holidays/types/:id */
async function updateHolidayType(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const typeId = holidayService.parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Holiday type id must be a positive integer.');

  try {
    const result = await holidayService.updateHolidayType(
      typeId,
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday type updated successfully.', result);
  } catch (error) {
    console.error('updateHolidayType error:', error);
    return sendError(res, 500, 'Something went wrong while updating holiday type.');
  }
}

/** DELETE /api/v1/holidays/types/:id */
async function deleteHolidayType(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const typeId = holidayService.parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Holiday type id must be a positive integer.');

  try {
    const result = await holidayService.deleteHolidayType(typeId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday type deleted successfully.', result);
  } catch (error) {
    console.error('deleteHolidayType error:', error);
    return sendError(res, 500, 'Something went wrong while deleting holiday type.');
  }
}

/** GET /api/v1/holidays/calendar */
async function getHolidayCalendar(req, res) {
  try {
    const result = await holidayService.getHolidayCalendar(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday calendar fetched successfully.', result);
  } catch (error) {
    console.error('getHolidayCalendar error:', error);
    return sendError(res, 500, 'Something went wrong while fetching holiday calendar.');
  }
}

/** POST /api/v1/holidays */
async function createHoliday(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await holidayService.createHoliday(Number(admin.company_id), req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Holiday created successfully.', result);
  } catch (error) {
    console.error('createHoliday error:', error);
    return sendError(res, 500, 'Something went wrong while creating holiday.');
  }
}

/** GET /api/v1/holidays */
async function getHolidays(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  try {
    const result = await holidayService.getHolidays(Number(admin.company_id), req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holidays fetched successfully.', result);
  } catch (error) {
    console.error('getHolidays error:', error);
    return sendError(res, 500, 'Something went wrong while fetching holidays.');
  }
}

/** GET /api/v1/holidays/:id */
async function getHolidayById(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const holidayId = holidayService.parsePositiveInt(req.params.id);
  if (!holidayId) return sendError(res, 400, 'Holiday id must be a positive integer.');

  try {
    const result = await holidayService.getHolidayById(holidayId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday fetched successfully.', result);
  } catch (error) {
    console.error('getHolidayById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching holiday.');
  }
}

/** PATCH /api/v1/holidays/:id */
async function updateHoliday(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const holidayId = holidayService.parsePositiveInt(req.params.id);
  if (!holidayId) return sendError(res, 400, 'Holiday id must be a positive integer.');

  try {
    const result = await holidayService.updateHoliday(
      holidayId,
      Number(admin.company_id),
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday updated successfully.', result);
  } catch (error) {
    console.error('updateHoliday error:', error);
    return sendError(res, 500, 'Something went wrong while updating holiday.');
  }
}

/** PUT /api/v1/holidays/:id */
async function replaceHoliday(req, res) {
  return updateHoliday(req, res);
}

/** DELETE /api/v1/holidays/:id */
async function deleteHoliday(req, res) {
  const admin = await resolveCompanyAdmin(req, res);
  if (!admin) return;

  const holidayId = holidayService.parsePositiveInt(req.params.id);
  if (!holidayId) return sendError(res, 400, 'Holiday id must be a positive integer.');

  try {
    const result = await holidayService.deleteHoliday(holidayId, Number(admin.company_id));
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Holiday deleted successfully.', result);
  } catch (error) {
    console.error('deleteHoliday error:', error);
    return sendError(res, 500, 'Something went wrong while deleting holiday.');
  }
}

module.exports = {
  createHolidayType,
  getHolidayTypes,
  getHolidayTypeById,
  updateHolidayType,
  deleteHolidayType,
  getHolidayCalendar,
  createHoliday,
  getHolidays,
  getHolidayById,
  updateHoliday,
  replaceHoliday,
  deleteHoliday,
};
