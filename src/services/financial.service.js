const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { paidTimestampNow, toUtcIsoString, utcNowForPgTimestamp, parseOptionalDateInput } = require('../utils/dateTime');
const { getEmployeeIdFromAuth } = require('../utils/employeeAuth');
const { loadLoanPaymentsMap, roundMoney } = require('./loanRequest.service');
const { creditForPfRepayment } = require('./pfBalance.service');

const REIMBURSEMENT_ADMIN_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
]);

const HR_REQUEST_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
]);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parsePositiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney(n);
}

async function getReviewerContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!HR_REQUEST_ROLES.has(user.role)) {
    return { error: 'You do not have permission to manage financial records.' };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.' };
  }
  return { user };
}

async function getExpenseStatusReviewerContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!REIMBURSEMENT_ADMIN_ROLES.has(user.role)) {
    return { error: 'Only admin or HR can update expense reimbursement status.' };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.' };
  }
  return { user };
}

async function getActiveUser(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  return { user };
}

function validateLoanPaymentBody(body) {
  const amount = parsePositiveAmount(body?.amount);
  if (!amount) {
    return { error: 'amount must be a positive number.' };
  }

  const notes = String(body?.notes || '').trim() || null;
  const paymentDateParsed = parseOptionalDateInput(body?.payment_date, 'payment_date');
  if (paymentDateParsed.error) {
    return { error: paymentDateParsed.error };
  }
  const paymentDate = paymentDateParsed.value;

  return { amount, notes, paymentDate };
}

function validateLoanPaymentRow(loan) {
  if (loan.request_type !== 'loan' && loan.request_type !== 'advance') {
    return { error: 'This request is not a loan or advance.', status: 400 };
  }
  if (loan.request_status !== 'approved') {
    return { error: 'Loan request must be approved before recording payments.', status: 409 };
  }
  if (loan.status === 'closed') {
    return { error: 'This loan is already fully paid.', status: 409 };
  }
  return null;
}

async function applyLoanPayment(client, loan, { amount, notes, paymentDate, recordedByUserId }) {
  const validationError = validateLoanPaymentRow(loan);
  if (validationError) return validationError;

  const outstanding = Number(loan.outstanding_balance);
  if (amount > outstanding) {
    return {
      error: `Payment amount cannot exceed outstanding balance (${outstanding}).`,
      status: 400,
    };
  }

  const newBalance = roundMoney(outstanding - amount);
  const newStatus = newBalance <= 0 ? 'closed' : 'active';
  const now = utcNowForPgTimestamp();

  await client.query(
    `INSERT INTO loan_payments (loan_id, amount, payment_date, notes, recorded_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5)`,
    [loan.id, amount, paymentDate, notes, recordedByUserId]
  );

  await client.query(
    `UPDATE loans
     SET outstanding_balance = $1,
         status = $2,
         updated_at = $3
     WHERE id = $4`,
    [newBalance, newStatus, now, loan.id]
  );

  const paymentsMap = await loadLoanPaymentsMap([Number(loan.id)]);

  return {
    data: {
      loan_id: Number(loan.id),
      payment_amount: amount,
      outstanding_balance: newBalance,
      status: newStatus,
      payments: paymentsMap.get(Number(loan.id)) || [],
    },
  };
}

async function recordLoanPayment(auth, requestId, body) {
  const reviewerCtx = await getReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const paymentBody = validateLoanPaymentBody(body);
  if (paymentBody.error) {
    return { error: paymentBody.error, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [id];
    let companyFilter = '';
    if (reviewerCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(reviewerCtx.user.company_id);
      companyFilter = ` AND r.company_id = $${params.length}`;
    }

    const loanResult = await client.query(
      `SELECT l.id, l.outstanding_balance, l.status, r.request_type, r.status AS request_status
       FROM requests r
       JOIN loans l ON l.request_id = r.id
       WHERE r.id = $1${companyFilter}
       FOR UPDATE OF l`,
      params
    );

    if (!loanResult.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Active loan not found for this request.', status: 404 };
    }

    const result = await applyLoanPayment(client, loanResult.rows[0], {
      amount: paymentBody.amount,
      notes: paymentBody.notes,
      paymentDate: paymentBody.paymentDate,
      recordedByUserId: reviewerCtx.user.id,
    });

    if (result.error) {
      await client.query('ROLLBACK');
      return result;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordEmployeeLoanPayment(auth, requestId, body) {
  const userCtx = await getActiveUser(auth);
  if (userCtx.error) {
    return { error: userCtx.error, status: 403 };
  }

  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'Employee profile not found.', status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const paymentBody = validateLoanPaymentBody(body);
  if (paymentBody.error) {
    return { error: paymentBody.error, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loanResult = await client.query(
      `SELECT l.id, l.outstanding_balance, l.status, r.request_type, r.status AS request_status
       FROM requests r
       JOIN loans l ON l.request_id = r.id
       WHERE r.id = $1 AND r.employee_id = $2
       FOR UPDATE OF l`,
      [id, employeeId]
    );

    if (!loanResult.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Active loan not found for this request.', status: 404 };
    }

    const result = await applyLoanPayment(client, loanResult.rows[0], {
      amount: paymentBody.amount,
      notes: paymentBody.notes,
      paymentDate: paymentBody.paymentDate,
      recordedByUserId: userCtx.user.id,
    });

    if (result.error) {
      await client.query('ROLLBACK');
      return result;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateExpenseReimbursementStatus(auth, requestId, body) {
  const reviewerCtx = await getExpenseStatusReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const newStatus = String(body?.reimbursement_status || '').trim().toLowerCase();
  if (newStatus !== 'paid') {
    return { error: 'Only marking expense as paid is allowed. Payable is set automatically on approval.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [id];
    let companyFilter = '';
    if (reviewerCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(reviewerCtx.user.company_id);
      companyFilter = ` AND r.company_id = $${params.length}`;
    }

    const result = await client.query(
      `SELECT r.id, r.request_type, r.status AS request_status,
              erd.reimbursement_status, erd.paid_in
       FROM requests r
       JOIN expense_request_details erd ON erd.request_id = r.id
       WHERE r.id = $1${companyFilter}
       FOR UPDATE OF r`,
      params
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Expense request not found.', status: 404 };
    }

    const row = result.rows[0];
    if (row.request_type !== 'expense') {
      await client.query('ROLLBACK');
      return { error: 'This request is not an expense claim.', status: 400 };
    }
    if (row.request_status !== 'approved') {
      await client.query('ROLLBACK');
      return { error: 'Expense request must be approved first.', status: 409 };
    }

    const currentStatus = row.reimbursement_status;
    if (currentStatus !== 'payable') {
      await client.query('ROLLBACK');
      return { error: 'Only payable expense claims can be marked paid.', status: 409 };
    }
    if (currentStatus === 'paid') {
      await client.query('ROLLBACK');
      return { error: 'Expense is already paid.', status: 409 };
    }
    if (row.paid_in !== 'cash') {
      await client.query('ROLLBACK');
      return {
        error: 'Only cash-paid expense claims can be confirmed here. Salary-paid claims are settled via payroll.',
        status: 409,
      };
    }

    const paymentDateParsed = parseOptionalDateInput(body?.payment_date, 'payment_date');
    if (paymentDateParsed.error) {
      await client.query('ROLLBACK');
      return { error: paymentDateParsed.error, status: 400 };
    }

    const paymentReference = String(body?.payment_reference || '').trim() || null;
    if (paymentReference && paymentReference.length > 120) {
      await client.query('ROLLBACK');
      return { error: 'payment_reference must be at most 120 characters.', status: 400 };
    }

    const paymentNotes = String(body?.notes || body?.payment_notes || '').trim() || null;
    if (paymentNotes && paymentNotes.length > 1000) {
      await client.query('ROLLBACK');
      return { error: 'notes must be at most 1000 characters.', status: 400 };
    }

    const paidTimestamp = paymentDateParsed.value
      ? `${paymentDateParsed.value} 12:00:00+00`
      : paidTimestampNow();

    await client.query(
      `UPDATE expense_request_details
       SET reimbursement_status = 'paid',
           paid_at = $1,
           payment_confirmed_by = $2,
           payment_reference = $3,
           payment_notes = $4
       WHERE request_id = $5`,
      [paidTimestamp, reviewerCtx.user.id, paymentReference, paymentNotes, id]
    );

    await client.query('COMMIT');

    const updated = await pool.query(
      `SELECT erd.reimbursement_status, erd.payable_at, erd.paid_at, erd.paid_in,
              erd.payment_reference, erd.payment_notes, erd.payment_confirmed_by,
              ec.name AS category_name
       FROM expense_request_details erd
       LEFT JOIN expense_categories ec ON ec.id = erd.category_id
       WHERE erd.request_id = $1`,
      [id]
    );
    const detail = updated.rows[0] || {};

    return {
      data: {
        request_id: id,
        reimbursement_status: detail.reimbursement_status,
        paid_in: detail.paid_in || null,
        payable_at: detail.payable_at ? toUtcIsoString(detail.payable_at) : null,
        paid_at: detail.paid_at ? toUtcIsoString(detail.paid_at) : null,
        payment_reference: detail.payment_reference || null,
        payment_notes: detail.payment_notes || null,
        payment_confirmed_by: detail.payment_confirmed_by
          ? Number(detail.payment_confirmed_by)
          : null,
        category_name: detail.category_name || null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validatePfPaymentRow(loan) {
  if (loan.request_status !== 'approved') {
    return { error: 'PF request must be approved before recording payments.', status: 409 };
  }
  if (loan.status === 'closed') {
    return { error: 'This PF recovery is already fully paid.', status: 409 };
  }
  return null;
}

async function recordPfPayment(auth, requestId, body) {
  const reviewerCtx = await getReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const paymentBody = validateLoanPaymentBody(body);
  if (paymentBody.error) {
    return { error: paymentBody.error, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [id];
    let companyFilter = '';
    if (reviewerCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(reviewerCtx.user.company_id);
      companyFilter = ` AND r.company_id = $${params.length}`;
    }

    const loanResult = await client.query(
      `SELECT l.id, l.employee_id, l.company_id, l.outstanding_balance, l.status, l.recovery_method,
              r.request_type, r.status AS request_status
       FROM requests r
       JOIN loans l ON l.request_id = r.id
       WHERE r.id = $1 AND l.loan_source = 'pf_temporary'${companyFilter}
       FOR UPDATE OF l`,
      params
    );

    if (!loanResult.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Active PF recovery not found for this request.', status: 404 };
    }

    const loanRow = loanResult.rows[0];
    const validationError = validatePfPaymentRow(loanRow);
    if (validationError) {
      await client.query('ROLLBACK');
      return validationError;
    }

    const result = await applyPfLoanPayment(client, loanRow, {
      amount: paymentBody.amount,
      notes: paymentBody.notes,
      paymentDate: paymentBody.paymentDate,
      recordedByUserId: reviewerCtx.user.id,
    });

    if (result.error) {
      await client.query('ROLLBACK');
      return result;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordEmployeePfRepayment(auth, requestId, body) {
  const userCtx = await getActiveUser(auth);
  if (userCtx.error) {
    return { error: userCtx.error, status: 403 };
  }

  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'Employee profile not found.', status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const paymentBody = validateLoanPaymentBody(body);
  if (paymentBody.error) {
    return { error: paymentBody.error, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loanResult = await client.query(
      `SELECT l.id, l.employee_id, l.company_id, l.outstanding_balance, l.status, l.recovery_method,
              r.request_type, r.status AS request_status
       FROM requests r
       JOIN loans l ON l.request_id = r.id
       WHERE r.id = $1 AND r.employee_id = $2 AND l.loan_source = 'pf_temporary'
       FOR UPDATE OF l`,
      [id, employeeId]
    );

    if (!loanResult.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Active PF recovery not found for this request.', status: 404 };
    }

    const loanRow = loanResult.rows[0];
    if (loanRow.recovery_method !== 'cash') {
      await client.query('ROLLBACK');
      return {
        error: 'Only cash-recovery PF requests can be repaid directly by the employee.',
        status: 409,
      };
    }

    const validationError = validatePfPaymentRow(loanRow);
    if (validationError) {
      await client.query('ROLLBACK');
      return validationError;
    }

    const result = await applyPfLoanPayment(client, loanRow, {
      amount: paymentBody.amount,
      notes: paymentBody.notes,
      paymentDate: paymentBody.paymentDate,
      recordedByUserId: userCtx.user.id,
    });

    if (result.error) {
      await client.query('ROLLBACK');
      return result;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyPfLoanPayment(client, loan, { amount, notes, paymentDate, recordedByUserId }) {
  const validationError = validatePfPaymentRow(loan);
  if (validationError) return validationError;

  const outstanding = Number(loan.outstanding_balance);
  if (amount > outstanding) {
    return {
      error: `Payment amount cannot exceed outstanding balance (${outstanding}).`,
      status: 400,
    };
  }

  const newBalance = roundMoney(outstanding - amount);
  const newStatus = newBalance <= 0 ? 'closed' : 'active';
  const now = utcNowForPgTimestamp();

  await client.query(
    `INSERT INTO loan_payments (loan_id, amount, payment_date, notes, recorded_by, payment_source)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, 'manual')`,
    [loan.id, amount, paymentDate, notes, recordedByUserId]
  );

  await client.query(
    `UPDATE loans
     SET outstanding_balance = $1,
         status = $2,
         updated_at = $3
     WHERE id = $4`,
    [newBalance, newStatus, now, loan.id]
  );

  if (loan.employee_id && loan.company_id) {
    const pfCredit = await creditForPfRepayment(client, {
      companyId: Number(loan.company_id),
      employeeId: Number(loan.employee_id),
      amount,
      referenceId: Number(loan.id),
      recordedBy: recordedByUserId,
    });
    if (pfCredit?.error) {
      return pfCredit;
    }
  }

  const paymentsMap = await loadLoanPaymentsMap([Number(loan.id)]);

  return {
    data: {
      loan_id: Number(loan.id),
      payment_amount: amount,
      outstanding_balance: newBalance,
      status: newStatus,
      payments: paymentsMap.get(Number(loan.id)) || [],
    },
  };
}

async function markPfPermanentPaid(auth, requestId) {
  const reviewerCtx = await getExpenseStatusReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const params = [id];
    let companyFilter = '';
    if (reviewerCtx.user.role !== USER_ROLES.SUPER_ADMIN) {
      params.push(reviewerCtx.user.company_id);
      companyFilter = ` AND r.company_id = $${params.length}`;
    }

    const result = await client.query(
      `SELECT r.id, r.request_type, r.status AS request_status,
              ppd.payout_status, ppd.amount
       FROM requests r
       JOIN pf_permanent_request_details ppd ON ppd.request_id = r.id
       WHERE r.id = $1${companyFilter}
       FOR UPDATE OF r`,
      params
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'PF permanent request not found.', status: 404 };
    }

    const row = result.rows[0];
    if (row.request_type !== 'pf_permanent') {
      await client.query('ROLLBACK');
      return { error: 'This request is not a PF permanent withdrawal.', status: 400 };
    }
    if (row.request_status !== 'approved') {
      await client.query('ROLLBACK');
      return { error: 'PF permanent request must be approved first.', status: 409 };
    }
    if (row.payout_status === 'paid') {
      await client.query('ROLLBACK');
      return { error: 'PF permanent withdrawal is already marked paid.', status: 409 };
    }
    if (row.payout_status !== 'payable') {
      await client.query('ROLLBACK');
      return { error: 'Only payable PF permanent withdrawals can be marked paid.', status: 409 };
    }

    const paidTimestamp = paidTimestampNow();

    await client.query(
      `UPDATE pf_permanent_request_details
       SET payout_status = 'paid',
           paid_at = $1
       WHERE request_id = $2`,
      [paidTimestamp, id]
    );

    await client.query('COMMIT');

    const updated = await pool.query(
      `SELECT amount, payout_status, payable_at, paid_at, payout_method
       FROM pf_permanent_request_details
       WHERE request_id = $1`,
      [id]
    );
    const detail = updated.rows[0] || {};

    return {
      data: {
        request_id: id,
        amount: detail.amount != null ? Number(detail.amount) : null,
        payout_status: detail.payout_status,
        payout_method: detail.payout_method || null,
        payable_at: detail.payable_at ? toUtcIsoString(detail.payable_at) : null,
        paid_at: detail.paid_at ? toUtcIsoString(detail.paid_at) : null,
        repayment_required: false,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
