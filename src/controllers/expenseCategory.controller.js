const expenseCategoryService = require('../services/expenseCategory.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');

function handleServiceError(res, result) {
  if (!result.error) return false;
  return sendError(res, result.error[0], result.error[1]);
}

/** POST /api/v1/expense-categories */
async function createExpenseCategory(req, res) {
  try {
    const result = await expenseCategoryService.createExpenseCategory(
      req.authUser,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Expense category created successfully.', result);
  } catch (error) {
    console.error('createExpenseCategory error:', error);
    return sendError(res, 500, 'Something went wrong while creating expense category.');
  }
}

/** GET /api/v1/expense-categories */
async function getExpenseCategories(req, res) {
  try {
    const result = await expenseCategoryService.getExpenseCategories(
      req.authUser,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Expense categories fetched successfully.', result);
  } catch (error) {
    console.error('getExpenseCategories error:', error);
    return sendError(res, 500, 'Something went wrong while fetching expense categories.');
  }
}

/** GET /api/v1/expense-categories/:id */
async function getExpenseCategoryById(req, res) {
  const categoryId = expenseCategoryService.parsePositiveInt(req.params.id);
  if (!categoryId) {
    return sendError(res, 400, 'Expense category id must be a positive integer.');
  }

  try {
    const result = await expenseCategoryService.getExpenseCategoryById(req.authUser, categoryId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Expense category fetched successfully.', result);
  } catch (error) {
    console.error('getExpenseCategoryById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching expense category.');
  }
}

/** PATCH /api/v1/expense-categories/:id */
async function updateExpenseCategory(req, res) {
  const categoryId = expenseCategoryService.parsePositiveInt(req.params.id);
  if (!categoryId) {
    return sendError(res, 400, 'Expense category id must be a positive integer.');
  }

  try {
    const result = await expenseCategoryService.updateExpenseCategory(
      req.authUser,
      categoryId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Expense category updated successfully.', result);
  } catch (error) {
    console.error('updateExpenseCategory error:', error);
    return sendError(res, 500, 'Something went wrong while updating expense category.');
  }
}

/** DELETE /api/v1/expense-categories/:id */
async function deleteExpenseCategory(req, res) {
  const categoryId = expenseCategoryService.parsePositiveInt(req.params.id);
  if (!categoryId) {
    return sendError(res, 400, 'Expense category id must be a positive integer.');
  }

  try {
    const result = await expenseCategoryService.deleteExpenseCategory(req.authUser, categoryId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Expense category deleted successfully.', result);
  } catch (error) {
    console.error('deleteExpenseCategory error:', error);
    return sendError(res, 500, 'Something went wrong while deleting expense category.');
  }
}

module.exports = {
  createExpenseCategory,
  getExpenseCategories,
  getExpenseCategoryById,
  updateExpenseCategory,
  deleteExpenseCategory,
};
