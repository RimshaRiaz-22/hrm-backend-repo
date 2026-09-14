const pool = require('../db');
const { utcNowForPgTimestamp, parseOptionalDateInput, toUtcIsoString } = require('../utils/dateTime');
const { roundMoney } = require('./loanRequest.service');
const {
  assertEnrolledPfAccount,
  debitForPfPermanentWithdrawal,
  creditForPfPermanentReversal,
} = require('./pfBalance.service');

const PAYOUT_METHODS = new Set(['payroll', 'direct', 'off_cycle']);

function parsePositiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney(n);
}

async function validatePfPermanentDetails(details, { client, employeeId }) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const amount = parsePositiveAmount(details.amount);
  if (!amount) {
    return { error: 'details.amount must be a positive number.' };
  }

  const withdrawalParsed = parseOptionalDateInput(
    details.withdrawal_date,
    'details.withdrawal_date'
  );
  if (withdrawalParsed.error) {
    return { error: withdrawalParsed.error };
  }
  if (!withdrawalParsed.value) {
    return { error: 'details.withdrawal_date is required.' };
  }

  const purpose = String(details.purpose || '').trim();
  if (!purpose) {
    return { error: 'details.purpose is required.' };
  }
  if (purpose.length > 2000) {
    return { error: 'details.purpose must be at most 2000 characters.' };
  }

  let payoutMethod = null;
  if (details.payout_method !== undefined && details.payout_method !== null) {
    payoutMethod = String(details.payout_method).trim().toLowerCase();
    if (!PAYOUT_METHODS.has(payoutMethod)) {
      return { error: 'details.payout_method must be payroll, direct, or off_cycle.' };
    }
  }

  const enrolled = await assertEnrolledPfAccount(client, employeeId);
  if (enrolled.error) {
    return enrolled;
  }

  if (amount > enrolled.account.balance) {
    return {
      error: `Requested amount exceeds available PF balance (${enrolled.account.balance}).`,
      status: 400,
    };
  }

  return {
    amount,
    withdrawalDate: withdrawalParsed.value,
    purpose,
    payoutMethod,
    pfBalance: enrolled.account.balance,
  };
}

async function previewPfPermanent(auth, details) {
  const { getEmployeeIdFromAuth, getEmployeeCompanyId } = require('../utils/employeeAuth');
  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const companyId = await getEmployeeCompanyId(employeeId);
  if (!companyId) {
    return { error: 'Employee company not found.', status: 404 };
  }

  const client = await pool.connect();
  try {
    const validation = await validatePfPermanentDetails(details, { client, employeeId });
    if (validation.error) {
      return { error: validation.error, status: validation.status || 400 };
    }

    return {
      data: {
        allowed: true,
        pf_balance: validation.pfBalance,
        requested_amount: validation.amount,
        balance_after_withdrawal: roundMoney(validation.pfBalance - validation.amount),
        payout_method: validation.payoutMethod,
        repayment_required: false,
      },
    };
  } finally {
    client.release();
  }
}

async function createPfPermanentRequest(client, { employeeId, companyId, requestType, details }) {
  const validation = await validatePfPermanentDetails(details, { client, employeeId });
  if (validation.error) {
    return { error: validation.error, status: validation.status || 400 };
  }

  const requestResult = await client.query(
    `INSERT INTO requests (company_id, employee_id, request_type, status, submitted_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id`,
    [companyId, employeeId, requestType, utcNowForPgTimestamp()]
  );
  const requestId = Number(requestResult.rows[0].id);

  await client.query(
    `INSERT INTO pf_permanent_request_details (
       request_id, amount, withdrawal_date, purpose, payout_method
     )
     VALUES ($1, $2, $3, $4, $5)`,
    [
      requestId,
      validation.amount,
      validation.withdrawalDate,
      validation.purpose,
      validation.payoutMethod,
    ]
  );

  return { requestId };
}

function mapPfPermanentDetailsRow(row) {
  if (!row) return null;
  return {
    amount: Number(row.amount),
    withdrawal_date: row.withdrawal_date ? String(row.withdrawal_date).slice(0, 10) : null,
    purpose: row.purpose,
    payout_method: row.payout_method || null,
    pf_balance_before:
      row.pf_balance_before != null ? Number(row.pf_balance_before) : null,
    payout_status: row.payout_status || 'pending',
    payable_at: row.payable_at ? toUtcIsoString(row.payable_at) : null,
    paid_at: row.paid_at ? toUtcIsoString(row.paid_at) : null,
    repayment_required: false,
  };
}

async function loadPfPermanentDetailsMap(requestIds) {
  const map = new Map();
  if (!requestIds.length) return map;

  const result = await pool.query(
    `SELECT *
     FROM pf_permanent_request_details
     WHERE request_id = ANY($1::bigint[])`,
    [requestIds]
  );

  for (const row of result.rows) {
    map.set(Number(row.request_id), mapPfPermanentDetailsRow(row));
  }

  return map;
}

async function applyPfPermanentApproval(client, { employeeId, companyId, requestId, recordedBy }) {
  const result = await client.query(
    `SELECT amount, payout_status
     FROM pf_permanent_request_details
     WHERE request_id = $1`,
    [requestId]
  );
  if (!result.rows[0]) {
    return { error: 'PF permanent request details not found.', status: 404 };
  }

  const row = result.rows[0];
  const amount = Number(row.amount);
  const enrolled = await assertEnrolledPfAccount(client, employeeId, { forUpdate: true });
  if (enrolled.error) {
    return { error: enrolled.error, status: enrolled.status || 400 };
  }

  if (amount > enrolled.account.balance) {
    return {
      error: `Cannot approve: employee's PF balance (${enrolled.account.balance}) is less than the requested withdrawal amount (${amount}).`,
      status: 400,
    };
  }

  const debitResult = await debitForPfPermanentWithdrawal(client, {
    companyId,
    employeeId,
    amount,
    referenceId: requestId,
    notes: 'PF permanent withdrawal approved',
    recordedBy,
  });
  if (debitResult?.error) {
    return { error: debitResult.error, status: debitResult.status || 400 };
  }

  const now = utcNowForPgTimestamp();
  await client.query(
    `UPDATE pf_permanent_request_details
     SET pf_balance_before = $1,
         payout_status = 'payable',
         payable_at = $2
     WHERE request_id = $3`,
    [enrolled.account.balance, now, requestId]
  );

  return {};
}

async function revertPfPermanentApproval(client, { employeeId, companyId, requestId, recordedBy }) {
  const detailResult = await client.query(
    `SELECT amount, payout_status
     FROM pf_permanent_request_details
     WHERE request_id = $1`,
    [requestId]
  );
  if (!detailResult.rows[0]) return;

  if (detailResult.rows[0].payout_status === 'paid') {
    throw new Error('Paid PF permanent withdrawals cannot be reversed.');
  }

  const amount = Number(detailResult.rows[0].amount);
  await creditForPfPermanentReversal(client, {
    companyId,
    employeeId,
    amount,
    referenceId: requestId,
    recordedBy,
    notes: 'PF permanent approval reversed',
  });

  await client.query(
    `UPDATE pf_permanent_request_details
     SET pf_balance_before = NULL,
         payout_status = 'pending',
         payable_at = NULL,
         paid_at = NULL
     WHERE request_id = $1`,
    [requestId]
  );
}

module.exports = {
  validatePfPermanentDetails,
  previewPfPermanent,
  createPfPermanentRequest,
  loadPfPermanentDetailsMap,
  applyPfPermanentApproval,
  revertPfPermanentApproval,
  mapPfPermanentDetailsRow,
};
