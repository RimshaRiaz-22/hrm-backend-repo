const pool = require('../db');
const {
  resolveExpenseReimbursementTimestamp,
  utcNowForPgTimestamp,
  toUtcIsoString,
  toDateKey,
  parseOptionalDateInput,
  DATE_YMD_REGEX,
} = require('../utils/dateTime');
const { assertActiveCategoryForCompany } = require('./expenseCategory.service');

const MONTH_REGEX = /^\d{4}-\d{2}$/;
const PAID_IN_VALUES = new Set(['salary', 'cash']);

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

function validateExpenseItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'details.items must be a non-empty array.' };
  }

  const normalized = [];
  let total = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      return { error: `details.items[${i}] must be an object.` };
    }

    const dateParsed = parseOptionalDateInput(item.date, `details.items[${i}].date`);
    if (dateParsed.error) {
      return { error: dateParsed.error };
    }
    if (!dateParsed.value) {
      return { error: `details.items[${i}].date is required.` };
    }
    const date = dateParsed.value;

    const description = String(item.description || '').trim();
    if (!description) {
      return { error: `details.items[${i}].description is required.` };
    }
    if (description.length > 500) {
      return { error: `details.items[${i}].description must be at most 500 characters.` };
    }

    const amount = parsePositiveAmount(item.amount);
    if (!amount) {
      return { error: `details.items[${i}].amount must be a positive number.` };
    }

    const receiptUrl = String(item.receipt_url || '').trim() || null;

    total += amount;
    normalized.push({
      date,
      description,
      amount,
      receipt_url: receiptUrl,
    });
  }

  return { items: normalized, totalAmount: roundMoney(total) };
}

function parseReimbursementFields(details) {
  const reimbursementDateRaw = String(details.reimbursement_date || '').trim();
  if (reimbursementDateRaw) {
    const reimbursementDateParsed = parseOptionalDateInput(
      reimbursementDateRaw,
      'details.reimbursement_date'
    );
    if (reimbursementDateParsed.error) {
      return { error: reimbursementDateParsed.error };
    }
    const reimbursementDate = reimbursementDateParsed.value;
    return {
      reimbursementDate,
      reimbursementMonth: reimbursementDate.slice(0, 7),
    };
  }

  const reimbursementMonth = String(details.reimbursement_month || '').trim();
  if (!reimbursementMonth) {
    return { reimbursementDate: null, reimbursementMonth: null };
  }
  if (DATE_YMD_REGEX.test(reimbursementMonth)) {
    return {
      reimbursementDate: reimbursementMonth,
      reimbursementMonth: reimbursementMonth.slice(0, 7),
    };
  }
  if (MONTH_REGEX.test(reimbursementMonth)) {
    return { reimbursementDate: null, reimbursementMonth };
  }

  return {
    error:
      'details.reimbursement_date must be YYYY-MM-DD or details.reimbursement_month must be YYYY-MM.',
  };
}

function validateExpenseDetails(details) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const categoryId = parsePositiveInt(details.category_id);
  if (!categoryId) {
    return { error: 'details.category_id is required and must be a positive integer.' };
  }

  const itemsValidation = validateExpenseItems(details.items);
  if (itemsValidation.error) {
    return itemsValidation;
  }

  const reimbursementFields = parseReimbursementFields(details);
  if (reimbursementFields.error) {
    return { error: reimbursementFields.error };
  }

  return {
    categoryId,
    items: itemsValidation.items,
    totalAmount: itemsValidation.totalAmount,
    reimbursementMonth: reimbursementFields.reimbursementMonth,
    reimbursementDate: reimbursementFields.reimbursementDate,
  };
}

async function createExpenseRequest(client, { employeeId, companyId, requestType, details }) {
  const validation = validateExpenseDetails(details);
  if (validation.error) {
    return { error: validation.error, status: 400 };
  }

  const categoryResult = await assertActiveCategoryForCompany(
    client,
    validation.categoryId,
    companyId
  );
  if (categoryResult.error) {
    return { error: categoryResult.error, status: 400 };
  }

  const requestResult = await client.query(
    `INSERT INTO requests (company_id, employee_id, request_type, status, submitted_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id`,
    [companyId, employeeId, requestType, utcNowForPgTimestamp()]
  );
  const requestId = Number(requestResult.rows[0].id);

  await client.query(
    `INSERT INTO expense_request_details (
       request_id, category_id, category, total_amount, items_json,
       reimbursement_month, reimbursement_date, reimbursement_status
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'pending')`,
    [
      requestId,
      categoryResult.categoryId,
      categoryResult.categoryName,
      validation.totalAmount,
      JSON.stringify(validation.items),
      validation.reimbursementMonth,
      validation.reimbursementDate,
    ]
  );

  return { requestId };
}

function mapExpenseDetailsRow(row) {
  if (!row) return null;
  let items = row.items_json;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  if (!Array.isArray(items)) items = [];

  return {
    category_id: row.category_id ? Number(row.category_id) : null,
    category_name: row.category_name || row.category || null,
    category: row.category_name || row.category || null,
    category_paid_in: row.category_paid_in || null,
    total_amount: Number(row.total_amount),
    items,
    paid_in: row.paid_in || null,
    reimbursement_month: row.reimbursement_month || null,
    reimbursement_date: toDateKey(row.reimbursement_date) || null,
    reimbursement_status: row.reimbursement_status || 'pending',
    payable_at: row.payable_at ? toUtcIsoString(row.payable_at) : null,
    paid_at: row.paid_at ? toUtcIsoString(row.paid_at) : null,
    payment_reference: row.payment_reference || null,
    payment_notes: row.payment_notes || null,
    payment_confirmed_by: row.payment_confirmed_by ? Number(row.payment_confirmed_by) : null,
  };
}

async function loadExpenseDetailsMap(requestIds) {
  const map = new Map();
  if (!requestIds.length) return map;

  const result = await pool.query(
    `SELECT erd.*,
            ec.name AS category_name,
            ec.paid_in AS category_paid_in
     FROM expense_request_details erd
     LEFT JOIN expense_categories ec ON ec.id = erd.category_id
     WHERE erd.request_id = ANY($1::bigint[])`,
    [requestIds]
  );

  for (const row of result.rows) {
    map.set(Number(row.request_id), mapExpenseDetailsRow(row));
  }

  return map;
}

async function loadCompanyTimezone(client, requestId) {
  const result = await client.query(
    `SELECT COALESCE(NULLIF(TRIM(c.timezone), ''), 'UTC') AS timezone
     FROM requests r
     JOIN companies c ON c.id = r.company_id
     WHERE r.id = $1`,
    [requestId]
  );
  return result.rows[0]?.timezone || 'UTC';
}

function normalizePaidIn(value) {
  const paidIn = String(value || '').trim().toLowerCase();
  if (!PAID_IN_VALUES.has(paidIn)) {
    return { error: 'paid_in must be salary or cash.' };
  }
  return { paidIn };
}

async function applyExpenseApproval(client, requestId, options = {}) {
  const paidInResult = normalizePaidIn(options.paid_in);
  if (paidInResult.error) {
    return { error: paidInResult.error };
  }

  const companyTimezone = options.company_timezone || (await loadCompanyTimezone(client, requestId));
  const statusTimestamp = resolveExpenseReimbursementTimestamp(
    'payable',
    options.status_date,
    companyTimezone
  );

  await client.query(
    `UPDATE expense_request_details
     SET reimbursement_status = 'payable',
         paid_in = $2,
         payable_at = $3,
         paid_at = NULL,
         payment_confirmed_by = NULL,
         payment_reference = NULL,
         payment_notes = NULL,
         reimbursement_month = COALESCE(
           NULLIF(TRIM(reimbursement_month), ''),
           TO_CHAR(COALESCE(reimbursement_date, $3::timestamp)::date, 'YYYY-MM')
         ),
         reimbursement_date = COALESCE(reimbursement_date, $3::timestamp::date)
     WHERE request_id = $1`,
    [requestId, paidInResult.paidIn, statusTimestamp]
  );

  return { paidIn: paidInResult.paidIn };
}

async function revertExpenseApproval(client, requestId) {
  await client.query(
    `UPDATE expense_request_details
     SET reimbursement_status = 'pending',
         paid_in = NULL,
         payable_at = NULL,
         paid_at = NULL,
         payment_confirmed_by = NULL,
         payment_reference = NULL,
         payment_notes = NULL
     WHERE request_id = $1`,
    [requestId]
  );
}

module.exports = {
  validateExpenseDetails,
  createExpenseRequest,
  loadExpenseDetailsMap,
  applyExpenseApproval,
  revertExpenseApproval,
  normalizePaidIn,
  PAID_IN_VALUES,
};
