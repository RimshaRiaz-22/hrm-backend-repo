const { sendSuccess, sendError } = require('../utils/apiResponse');
const financialService = require('../services/financial.service');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}

async function recordLoanPayment(req, res) {
  try {
    const result = await financialService.recordLoanPayment(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'Loan payment recorded successfully.');
  } catch (error) {
    console.error('Record loan payment error:', error);
    return sendError(res, 500, 'Something went wrong while recording the loan payment.');
  }
}

async function updateExpenseReimbursementStatus(req, res) {
  try {
    const result = await financialService.updateExpenseReimbursementStatus(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'Expense reimbursement status updated.');
  } catch (error) {
    console.error('Update expense reimbursement status error:', error);
    return sendError(
      res,
      500,
      'Something went wrong while updating expense reimbursement status.'
    );
  }
}

async function recordEmployeeLoanPayment(req, res) {
  try {
    const result = await financialService.recordEmployeeLoanPayment(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'Loan repayment recorded successfully.');
  } catch (error) {
    console.error('Record employee loan payment error:', error);
    return sendError(res, 500, 'Something went wrong while recording the loan repayment.');
  }
}

async function recordPfPayment(req, res) {
  try {
    const result = await financialService.recordPfPayment(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'PF payment recorded successfully.');
  } catch (error) {
    console.error('Record PF payment error:', error);
    return sendError(res, 500, 'Something went wrong while recording the PF payment.');
  }
}

async function recordEmployeePfRepayment(req, res) {
  try {
    const result = await financialService.recordEmployeePfRepayment(
      req.authUser,
      req.params.id,
      req.body
    );
    return handleServiceResult(res, result, 'PF repayment recorded successfully.');
  } catch (error) {
    console.error('Record employee PF repayment error:', error);
    return sendError(res, 500, 'Something went wrong while recording the PF repayment.');
  }
}

async function markPfPermanentPaid(req, res) {
  try {
    const result = await financialService.markPfPermanentPaid(req.authUser, req.params.id);
    return handleServiceResult(res, result, 'PF permanent withdrawal marked as paid.');
  } catch (error) {
    console.error('Mark PF permanent paid error:', error);
    return sendError(res, 500, 'Something went wrong while marking PF permanent withdrawal as paid.');
  }
}

module.exports = {
  recordLoanPayment,
  recordEmployeeLoanPayment,
  recordPfPayment,
  recordEmployeePfRepayment,
  updateExpenseReimbursementStatus,
  markPfPermanentPaid,
};
