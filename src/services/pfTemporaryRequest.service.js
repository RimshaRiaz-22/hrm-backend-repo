const pool = require('../db');
const { utcNowForPgTimestamp, parseOptionalDateInput } = require('../utils/dateTime');
const { roundMoney } = require('./loanRequest.service');
const {
  assertEnrolledPfAccount,
  debitForPfTemporaryWithdrawal,
  creditForPfTemporaryReversal,
} = require('./pfBalance.service');
const { loadLoanPaymentsMap } = require('./loanRequest.service');

const MONTH_REGEX = /^\d{4}-\d{2}$/;
const RECOVERY_METHODS = new Set(['salary_deduction', 'cash']);
const INSTALLMENT_BASES = new Set(['fixed_amount', 'percentage_of_basic']);

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

async function getEmployeeBasicSalary(client, employeeId) {
  const result = await client.query(
    `SELECT salary FROM employee_job_details WHERE employee_id = $1`,
    [employeeId]
  );
  const salary = result.rows[0]?.salary;
  if (salary == null || Number(salary) <= 0) return null;
  return roundMoney(salary);
}

function computeInstallmentPlan({ amount, installmentBasis, installmentAmount, installmentPercentage, basicSalary }) {
  let emiAmount = null;

  if (installmentBasis === 'fixed_amount') {
    emiAmount = installmentAmount;
  } else {
    if (!basicSalary) {
      return { error: 'Employee basic salary is not configured for percentage-based installments.' };
    }
    emiAmount = roundMoney((basicSalary * installmentPercentage) / 100);
  }

  if (!emiAmount || emiAmount <= 0) {
    return { error: 'Calculated EMI must be greater than zero.' };
  }
  if (emiAmount > amount) {
    return { error: 'Installment amount cannot exceed the requested PF withdrawal amount.' };
  }

  const tenureMonths = Math.ceil(amount / emiAmount);
  if (tenureMonths > 120) {
    return { error: 'Repayment tenure cannot exceed 120 months.' };
  }

  return { emiAmount, tenureMonths };
}

async function validatePfTemporaryDetails(details, { client, employeeId, companyId }) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const amount = parsePositiveAmount(details.amount);
  if (!amount) {
    return { error: 'details.amount must be a positive number.' };
  }

  const recoveryMethod = String(details.recovery_method || '').trim().toLowerCase();
  if (!RECOVERY_METHODS.has(recoveryMethod)) {
    return { error: 'details.recovery_method must be salary_deduction or cash.' };
  }

  const installmentBasis = String(details.installment_basis || '').trim().toLowerCase();
  if (!INSTALLMENT_BASES.has(installmentBasis)) {
    return { error: 'details.installment_basis must be fixed_amount or percentage_of_basic.' };
  }

  let installmentAmount = null;
  let installmentPercentage = null;

  if (installmentBasis === 'fixed_amount') {
    installmentAmount = parsePositiveAmount(details.installment_amount);
    if (!installmentAmount) {
      return { error: 'details.installment_amount is required for fixed_amount installments.' };
    }
  } else {
    const pct = Number(details.installment_percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return { error: 'details.installment_percentage must be between 0 and 100.' };
    }
    installmentPercentage = roundMoney(pct);
  }

  const loanTakenParsed = parseOptionalDateInput(details.loan_taken_date, 'details.loan_taken_date');
  if (loanTakenParsed.error) {
    return { error: loanTakenParsed.error };
  }
  if (!loanTakenParsed.value) {
    return { error: 'details.loan_taken_date is required.' };
  }

  const purpose = String(details.purpose || '').trim();
  if (!purpose) {
    return { error: 'details.purpose is required.' };
  }
  if (purpose.length > 2000) {
    return { error: 'details.purpose must be at most 2000 characters.' };
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

  const basicSalary = await getEmployeeBasicSalary(client, employeeId);
  const plan = computeInstallmentPlan({
    amount,
    installmentBasis,
    installmentAmount,
    installmentPercentage,
    basicSalary,
  });
  if (plan.error) {
    return { error: plan.error };
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
    recoveryMethod,
    installmentBasis,
    installmentAmount,
    installmentPercentage,
    emiAmount: plan.emiAmount,
    tenureMonths: plan.tenureMonths,
    loanTakenDate: loanTakenParsed.value,
    repaymentStart,
    purpose,
    pfBalance: enrolled.account.balance,
  };
}

async function previewPfTemporary(auth, details) {
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
    const validation = await validatePfTemporaryDetails(details, { client, employeeId, companyId });
    if (validation.error) {
      return { error: validation.error, status: validation.status || 400 };
    }

    return {
      data: {
        allowed: true,
        pf_balance: validation.pfBalance,
        requested_amount: validation.amount,
        emi_amount: validation.emiAmount,
        tenure_months: validation.tenureMonths,
        recovery_method: validation.recoveryMethod,
        installment_basis: validation.installmentBasis,
      },
    };
  } finally {
    client.release();
  }
}

async function createPfTemporaryRequest(client, { employeeId, companyId, requestType, details }) {
  const validation = await validatePfTemporaryDetails(details, { client, employeeId, companyId });
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
    `INSERT INTO pf_temporary_request_details (
       request_id, amount, recovery_method, installment_basis,
       installment_amount, installment_percentage, emi_amount, tenure_months,
       loan_taken_date, repayment_start, purpose
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      requestId,
      validation.amount,
      validation.recoveryMethod,
      validation.installmentBasis,
      validation.installmentAmount,
      validation.installmentPercentage,
      validation.emiAmount,
      validation.tenureMonths,
      validation.loanTakenDate,
      validation.repaymentStart,
      validation.purpose,
    ]
  );

  return { requestId };
}

function mapPfTemporaryDetailsRow(row) {
  if (!row) return null;
  return {
    amount: Number(row.amount),
    recovery_method: row.recovery_method,
    installment_basis: row.installment_basis,
    installment_amount:
      row.installment_amount != null ? Number(row.installment_amount) : null,
    installment_percentage:
      row.installment_percentage != null ? Number(row.installment_percentage) : null,
    emi_amount: Number(row.emi_amount),
    tenure_months: Number(row.tenure_months),
    loan_taken_date: row.loan_taken_date ? String(row.loan_taken_date).slice(0, 10) : null,
    repayment_start: row.repayment_start || null,
    purpose: row.purpose,
    pf_balance_before:
      row.pf_balance_before != null ? Number(row.pf_balance_before) : null,
  };
}

async function loadPfTemporaryDetailsMap(requestIds) {
  const map = new Map();
  if (!requestIds.length) return map;

  const result = await pool.query(
    `SELECT ptd.*,
            l.id AS loan_id,
            l.outstanding_balance,
            l.status AS loan_status,
            l.start_month,
            l.recovery_method AS loan_recovery_method
     FROM pf_temporary_request_details ptd
     LEFT JOIN loans l ON l.request_id = ptd.request_id
     WHERE ptd.request_id = ANY($1::bigint[])`,
    [requestIds]
  );

  for (const row of result.rows) {
    const details = mapPfTemporaryDetailsRow(row);
    if (row.loan_id) {
      details.recovery = {
        id: Number(row.loan_id),
        outstanding_balance: Number(row.outstanding_balance),
        status: row.loan_status,
        start_month: row.start_month || null,
        recovery_method: row.loan_recovery_method || row.recovery_method,
      };
    }
    map.set(Number(row.request_id), details);
  }

  return map;
}

async function applyPfTemporaryApproval(client, { employeeId, companyId, requestId, recordedBy }) {
  const result = await client.query(
    `SELECT amount, recovery_method, emi_amount, tenure_months, repayment_start
     FROM pf_temporary_request_details
     WHERE request_id = $1`,
    [requestId]
  );
  if (!result.rows[0]) {
    return { error: 'PF temporary request details not found.', status: 404 };
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

  const debitResult = await debitForPfTemporaryWithdrawal(client, {
    companyId,
    employeeId,
    amount,
    referenceId: requestId,
    notes: 'PF temporary withdrawal approved',
    recordedBy,
  });
  if (debitResult?.error) {
    return { error: debitResult.error, status: debitResult.status || 400 };
  }

  await client.query(
    `UPDATE pf_temporary_request_details
     SET pf_balance_before = $1
     WHERE request_id = $2`,
    [enrolled.account.balance, requestId]
  );

  const repaymentStart = row.repayment_start ? String(row.repayment_start).trim() : null;
  const startMonth = repaymentStart ? repaymentStart.slice(0, 7) : null;

  await client.query(
    `INSERT INTO loans (
       company_id, employee_id, request_id, amount, tenure_months, emi_amount,
       repayment_type, outstanding_balance, start_month, status,
       recovery_method, loan_source
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'installment', $7, $8, 'active', $9, 'pf_temporary')`,
    [
      companyId,
      employeeId,
      requestId,
      amount,
      row.tenure_months,
      row.emi_amount,
      amount,
      startMonth,
      row.recovery_method,
    ]
  );

  return {};
}

async function revertPfTemporaryApproval(client, { employeeId, companyId, requestId, recordedBy }) {
  const detailResult = await client.query(
    `SELECT amount FROM pf_temporary_request_details WHERE request_id = $1`,
    [requestId]
  );
  if (!detailResult.rows[0]) return;

  const loanResult = await client.query(
    `SELECT id, outstanding_balance, amount FROM loans WHERE request_id = $1`,
    [requestId]
  );
  const loan = loanResult.rows[0];

  await client.query(`DELETE FROM loans WHERE request_id = $1`, [requestId]);

  const repaidAmount = loan ? roundMoney(Number(loan.amount) - Number(loan.outstanding_balance)) : 0;
  const amount = Number(detailResult.rows[0].amount);
  const creditAmount = roundMoney(amount - repaidAmount);

  if (creditAmount > 0) {
    await creditForPfTemporaryReversal(client, {
      companyId,
      employeeId,
      amount: creditAmount,
      referenceId: requestId,
      recordedBy,
      notes: 'PF temporary approval reversed',
    });
  }

  await client.query(
    `UPDATE pf_temporary_request_details
     SET pf_balance_before = NULL
     WHERE request_id = $1`,
    [requestId]
  );
}

async function enrichPfTemporaryPayments(items) {
  const loanIds = [];
  for (const item of items) {
    if (item.details?.recovery?.id) {
      loanIds.push(item.details.recovery.id);
    }
  }
  if (!loanIds.length) return items;

  const paymentsMap = await loadLoanPaymentsMap(loanIds);
  return items.map((item) => {
    if (item.request_type !== 'pf_temporary' || !item.details?.recovery?.id) return item;
    return {
      ...item,
      details: {
        ...item.details,
        payments: paymentsMap.get(item.details.recovery.id) || [],
      },
    };
  });
}

module.exports = {
  validatePfTemporaryDetails,
  previewPfTemporary,
  createPfTemporaryRequest,
  loadPfTemporaryDetailsMap,
  applyPfTemporaryApproval,
  revertPfTemporaryApproval,
  enrichPfTemporaryPayments,
};
