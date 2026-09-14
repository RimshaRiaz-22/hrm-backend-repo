const monthlyInputService = require('../services/monthlyInput.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

/** POST /api/v1/payroll/monthly-inputs */
async function create(req, res) {
  try {
    const result = await monthlyInputService.create(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    const message = result.warning
      ? 'Monthly inputs created successfully (with warning).'
      : 'Monthly inputs created successfully.';
    return sendSuccess(res, 201, message, result);
  } catch (error) {
    console.error('createMonthlyInputs error:', error);
    return sendError(res, 500, 'Something went wrong while creating monthly inputs.');
  }
}

/** POST /api/v1/payroll/monthly-inputs/import */
async function importRows(req, res) {
  try {
    const result = await monthlyInputService.bulkCreate(req.authUser, req.body || {});
    if (handleServiceError(res, result)) return;
    const message = result.warning
      ? 'Monthly inputs imported successfully (with warning).'
      : 'Monthly inputs imported successfully.';
    return sendSuccess(res, 201, message, result);
  } catch (error) {
    console.error('importMonthlyInputs error:', error);
    return sendError(res, 500, 'Something went wrong while importing monthly inputs.');
  }
}

/** GET /api/v1/payroll/monthly-inputs */
async function list(req, res) {
  try {
    const result = await monthlyInputService.list(req.authUser, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Monthly inputs fetched successfully.', result);
  } catch (error) {
    console.error('listMonthlyInputs error:', error);
    return sendError(res, 500, 'Something went wrong while fetching monthly inputs.');
  }
}

/** GET /api/v1/payroll/monthly-inputs/:id */
async function getOne(req, res) {
  try {
    const result = await monthlyInputService.getById(req.authUser, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Monthly input fetched successfully.', result);
  } catch (error) {
    console.error('getMonthlyInput error:', error);
    return sendError(res, 500, 'Something went wrong while fetching monthly input.');
  }
}

/** PATCH /api/v1/payroll/monthly-inputs/:id */
async function update(req, res) {
  try {
    const result = await monthlyInputService.update(req.authUser, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    const message = result.warning
      ? 'Monthly input updated successfully (with warning).'
      : 'Monthly input updated successfully.';
    return sendSuccess(res, 200, message, result);
  } catch (error) {
    console.error('updateMonthlyInput error:', error);
    return sendError(res, 500, 'Something went wrong while updating monthly input.');
  }
}

/** PATCH /api/v1/payroll/monthly-inputs/transition */
async function transition(req, res) {
  try {
    const body = req.body || {};
    const result = await monthlyInputService.transition(req.authUser, body.ids, body.action);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, `Monthly inputs moved to ${result.status}.`, result);
  } catch (error) {
    console.error('transitionMonthlyInputs error:', error);
    return sendError(res, 500, 'Something went wrong while transitioning monthly inputs.');
  }
}

/** DELETE /api/v1/payroll/monthly-inputs */
async function remove(req, res) {
  try {
    const body = req.body || {};
    const result = await monthlyInputService.remove(req.authUser, body.ids);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Monthly inputs deleted successfully.', result);
  } catch (error) {
    console.error('deleteMonthlyInputs error:', error);
    return sendError(res, 500, 'Something went wrong while deleting monthly inputs.');
  }
}

module.exports = {
  create,
  importRows,
  list,
  getOne,
  update,
  transition,
  remove,
};
