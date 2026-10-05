const pool = require('../db');
const { utcNowForPgTimestamp, parseOptionalDateInput, DATE_YMD_REGEX } = require('../utils/dateTime');

const MONTH_REGEX = /^\d{4}-\d{2}$/;
const REPAYMENT_TYPES = new Set(['installment', 'one_time']);

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parsePositiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney(n);
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function validateLoanDetails(details, requestType = 'loan') {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const amount = parsePositiveAmount(details.amount);
  if (!amount) {
    return { error: 'details.amount must be a positive number.' };
  }

  const isAdvance = requestType === 'advance';
  let repaymentType = String(details.repayment_type || '').trim().toLowerCase();
  if (isAdvance) {
    // Advances are always recovered in one shot (typically the next payroll run).
    repaymentType = 'one_time';
  } else if (!REPAYMENT_TYPES.has(repaymentType)) {
    return { error: 'details.repayment_type must be installment or one_time.' };
  }

  const purpose = String(details.purpose || '').trim();
  if (!purpose) {
    return { error: 'details.purpose is required.' };
  }
  if (purpose.length > 2000) {
    return { error: 'details.purpose must be at most 2000 characters.' };
  }

  let tenureMonths = null;
  let emiAmount = null;

  if (repaymentType === 'installment') {
    tenureMonths = parsePositiveInt(details.tenure_months);
    if (!tenureMonths) {
      return { error: 'details.tenure_months is required for installment loans.' };
    }
    if (tenureMonths > 120) {
      return { error: 'details.tenure_months cannot exceed 120.' };
    }
    emiAmount = roundMoney(amount / tenureMonths);
  } else {
    emiAmount = amount;
  }

  const repaymentStartRaw = String(details.repayment_start || '').trim();
  let repaymentStart = null;
  if (repaymentStartRaw) {
    if (MONTH_REGEX.test(repaymentStartRaw)) {
      repaymentStart = repaymentStartRaw;
    } else {
      const repaymentStartParsed = parseOptionalDateInput(
        repaymentStartRaw,
        'details.repayment_start'
      );
      if (repaymentStartParsed.error) {
        return { error: repaymentStartParsed.error };
      }
      repaymentStart = repaymentStartParsed.value;
    }
  }

  return {
    amount,
    tenureMonths,
    emiAmount,
    repaymentType,
    purpose,
    repaymentStart,
  };
}

async function createLoanRequest(client, { employeeId, companyId, requestType, details }) {
  const validation = validateLoanDetails(details, requestType);
  if (validation.error) {
    return { error: validation.error, status: 400 };
  }

  const requestResult = await client.query(
    `INSERT INTO requests (company_id, employee_id, request_type, status, submitted_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id`,
    [companyId, employeeId, requestType, utcNowForPgTimestamp()]
  );
  const requestId = Number(requestResult.rows[0].id);

  await client.query(
    `INSERT INTO loan_request_details (
       request_id, amount, tenure_months, emi_amount, repayment_type, purpose, repayment_start
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      requestId,
      validation.amount,
      validation.tenureMonths,
      validation.emiAmount,
      validation.repaymentType,
      validation.purpose,
      validation.repaymentStart,
    ]
  );

  return { requestId };
}

function mapLoanDetailsRow(row) {
  if (!row) return null;
  return {
    amount: Number(row.amount),
    tenure_months: row.tenure_months != null ? Number(row.tenure_months) : null,
    emi_amount: row.emi_amount != null ? Number(row.emi_amount) : null,
    repayment_type: row.repayment_type,
    purpose: row.purpose,
    repayment_start: row.repayment_start || null,
  };
}

async function loadLoanDetailsMap(requestIds) {
  const map = new Map();
  if (!requestIds.length) return map;

  const result = await pool.query(
    `SELECT lrd.*,
            l.id AS loan_id,
            l.outstanding_balance,
            l.status AS loan_status,
            l.start_month
     FROM loan_request_details lrd
     LEFT JOIN loans l ON l.request_id = lrd.request_id
     WHERE lrd.request_id = ANY($1::bigint[])`,
    [requestIds]
  );

  for (const row of result.rows) {
    const details = mapLoanDetailsRow(row);
    if (row.loan_id) {
      details.loan = {
        id: Number(row.loan_id),
        outstanding_balance: Number(row.outstanding_balance),
        status: row.loan_status,
        start_month: row.start_month || null,
      };
    }
    map.set(Number(row.request_id), details);
  }

  return map;
}

async function loadLoanPaymentsMap(loanIds) {
  const map = new Map();
  if (!loanIds.length) return map;

  const result = await pool.query(
    `SELECT id, loan_id, amount, payment_date, notes, recorded_by, created_at
     FROM loan_payments
     WHERE loan_id = ANY($1::bigint[])
     ORDER BY payment_date DESC, id DESC`,
    [loanIds]
  );

  for (const row of result.rows) {
    const loanId = Number(row.loan_id);
    if (!map.has(loanId)) map.set(loanId, []);
    map.get(loanId).push({
      id: Number(row.id),
      amount: Number(row.amount),
      payment_date: row.payment_date ? String(row.payment_date).slice(0, 10) : null,
      notes: row.notes || null,
      recorded_by: row.recorded_by ? Number(row.recorded_by) : null,
      created_at: row.created_at,
    });
  }

  return map;
}

async function applyLoanApproval(client, { employeeId, companyId, requestId }) {
  const result = await client.query(
    `SELECT amount, tenure_months, emi_amount, repayment_type, repayment_start
     FROM loan_request_details
     WHERE request_id = $1`,
    [requestId]
  );
  if (!result.rows[0]) {
    throw new Error('Loan request details not found.');
  }

  const row = result.rows[0];
  const amount = Number(row.amount);
  const repaymentStart = row.repayment_start ? String(row.repayment_start).trim() : null;
  const startMonth = repaymentStart ? repaymentStart.slice(0, 7) : null;

  await client.query(
    `INSERT INTO loans (
       company_id, employee_id, request_id, amount, tenure_months, emi_amount,
       repayment_type, outstanding_balance, start_month, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
    [
      companyId,
      employeeId,
      requestId,
      amount,
      row.tenure_months,
      row.emi_amount,
      row.repayment_type,
      amount,
      startMonth,
    ]
  );
}

async function revertLoanApproval(client, requestId) {
  await client.query(`DELETE FROM loans WHERE request_id = $1`, [requestId]);
}

module.exports = {
  validateLoanDetails,
  createLoanRequest,
  loadLoanDetailsMap,
  loadLoanPaymentsMap,
  applyLoanApproval,
  revertLoanApproval,
  roundMoney,
};
