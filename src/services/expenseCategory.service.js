const pool = require('../db');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const {
  toUtcIsoString,
  utcNowForPgTimestamp,
  toDateKey,
  normalizeDateInput,
} = require('../utils/dateTime');

const EXPENSE_CATEGORY_STATUSES = new Set(['active', 'inactive']);
const PAID_IN_VALUES = new Set(['salary', 'cash']);
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,19}$/;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function resolveCompanyIdFromAuth(authUser) {
  const companyId = parsePositiveInt(authUser?.companyId ?? authUser?.company_id);
  if (!companyId) {
    return { error: [403, 'Your account must be linked to a company.'] };
  }
  return { companyId };
}

function normalizeName(raw) {
  const name = String(raw || '').trim();
  if (!name) return { error: 'name is required.' };
  if (name.length > 120) return { error: 'name must be at most 120 characters.' };
  return { name };
}

function normalizeOptionalCode(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { code: null };
  }
  const code = String(raw).trim().toLowerCase();
  if (!code) return { code: null };
  if (!CODE_PATTERN.test(code)) {
    return {
      error:
        'code must be 1–20 characters: start with a letter, then lowercase letters, digits, or underscores only.',
    };
  }
  return { code };
}

function normalizeOptionalDescription(raw) {
  if (raw === undefined || raw === null) return { description: null };
  const description = String(raw).trim();
  if (!description) return { description: null };
  if (description.length > 1000) {
    return { error: 'description must be at most 1000 characters.' };
  }
  return { description };
}

function normalizeStatus(raw, defaultValue = 'active') {
  if (raw === undefined || raw === null || raw === '') {
    return { status: defaultValue };
  }
  const status = String(raw).trim().toLowerCase();
  if (!EXPENSE_CATEGORY_STATUSES.has(status)) {
    return { error: 'status must be active or inactive.' };
  }
  return { status };
}

function normalizePaidIn(raw, { required = true, defaultValue = 'salary' } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) {
      if (defaultValue && PAID_IN_VALUES.has(defaultValue)) {
        return { paidIn: defaultValue };
      }
      return { error: 'paid_in is required and must be salary or cash.' };
    }
    return { paidIn: undefined };
  }
  const paidIn = String(raw).trim().toLowerCase();
  if (!PAID_IN_VALUES.has(paidIn)) {
    return { error: 'paid_in must be salary or cash.' };
  }
  return { paidIn };
}

function normalizeEffectiveFrom(raw, { required = true, defaultValue = null } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return { effectiveFrom: undefined };
    if (defaultValue) return { effectiveFrom: defaultValue };
    const today = toDateKey(new Date());
    return { effectiveFrom: today };
  }
  const normalized = normalizeDateInput(raw, {
    fieldName: 'effective_from',
    allowEmpty: false,
  });
  if (normalized.error) return { error: normalized.error };
  return { effectiveFrom: normalized.value };
}

function mapExpenseCategoryRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    code: row.code || null,
    description: row.description || null,
    paid_in: row.paid_in || 'salary',
    effective_from: toDateKey(row.effective_from),
    status: row.status,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

async function createExpenseCategory(authUser, body = {}) {
  const companyResult = resolveCompanyIdFromAuth(authUser);
  if (companyResult.error) return { error: companyResult.error };

  const nameResult = normalizeName(body.name);
  if (nameResult.error) return { error: [400, nameResult.error] };

  const codeResult = normalizeOptionalCode(body.code);
  if (codeResult.error) return { error: [400, codeResult.error] };

  const descriptionResult = normalizeOptionalDescription(body.description);
  if (descriptionResult.error) return { error: [400, descriptionResult.error] };

  const paidInResult = normalizePaidIn(body.paid_in, { required: true, defaultValue: 'salary' });
  if (paidInResult.error) return { error: [400, paidInResult.error] };

  const effectiveFromResult = normalizeEffectiveFrom(body.effective_from, { required: true });
  if (effectiveFromResult.error) return { error: [400, effectiveFromResult.error] };

  const statusResult = normalizeStatus(body.status, 'active');
  if (statusResult.error) return { error: [400, statusResult.error] };

  try {
    const nowUtc = utcNowForPgTimestamp();
    const insert = await pool.query(
      `INSERT INTO expense_categories (
         company_id, name, code, description, paid_in, effective_from, status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8::timestamp, $8::timestamp)
       RETURNING *`,
      [
        companyResult.companyId,
        nameResult.name,
        codeResult.code,
        descriptionResult.description,
        paidInResult.paidIn,
        effectiveFromResult.effectiveFrom,
        statusResult.status,
        nowUtc,
      ]
    );

    return {
      expense_category: mapExpenseCategoryRow(insert.rows[0]),
    };
  } catch (error) {
    if (error?.code === '23505') {
      return {
        error: [409, 'An expense category with this name already exists for this company.'],
      };
    }
    if (error?.code === '23503') {
      return { error: [400, 'company_id does not reference a valid company.'] };
    }
    throw error;
  }
}

async function getExpenseCategories(authUser, query = {}) {
  const companyResult = resolveCompanyIdFromAuth(authUser);
  if (companyResult.error) return { error: companyResult.error };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const search = String(query.search || '').trim();
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;

  const status = String(query.status || '').trim().toLowerCase();
  const hasStatus = EXPENSE_CATEGORY_STATUSES.has(status);

  let effectiveAsOf = null;
  const effectiveAsOfRaw = query.effective_as_of ?? query.as_of;
  if (effectiveAsOfRaw !== undefined && effectiveAsOfRaw !== null && effectiveAsOfRaw !== '') {
    const asOfResult = normalizeEffectiveFrom(effectiveAsOfRaw, { required: true });
    if (asOfResult.error) return { error: [400, asOfResult.error] };
    effectiveAsOf = asOfResult.effectiveFrom;
  } else if (String(query.for_request || '').trim() === '1' || query.for_request === true) {
    effectiveAsOf = toDateKey(new Date());
  }

  const paidInFilter = String(query.paid_in || '').trim().toLowerCase();
  const hasPaidIn = PAID_IN_VALUES.has(paidInFilter);

  const params = [companyResult.companyId];
  const conditions = ['company_id = $1'];

  if (hasStatus) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (effectiveAsOf) {
    params.push(effectiveAsOf);
    conditions.push(`effective_from <= $${params.length}::date`);
  }

  if (hasPaidIn) {
    params.push(paidInFilter);
    conditions.push(`paid_in = $${params.length}`);
  }

  params.push(hasSearch ? searchLike : '');
  const searchIndex = params.length;
  conditions.push(`(
    $${searchIndex}::text = ''
    OR name ILIKE $${searchIndex}
    OR COALESCE(code, '') ILIKE $${searchIndex}
    OR COALESCE(description, '') ILIKE $${searchIndex}
  )`);

  const whereClause = conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM expense_categories
     WHERE ${whereClause}`,
    params
  );

  const listParams = [...params];
  let listSql = `SELECT *
     FROM expense_categories
     WHERE ${whereClause}
     ORDER BY name ASC`;

  if (!listPagination.noPagination) {
    listParams.push(listPagination.pagination.limit, listPagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const listResult = await pool.query(listSql, listParams);

  return {
    expense_categories: listResult.rows.map(mapExpenseCategoryRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getExpenseCategoryById(authUser, categoryId) {
  const companyResult = resolveCompanyIdFromAuth(authUser);
  if (companyResult.error) return { error: companyResult.error };

  const id = parsePositiveInt(categoryId);
  if (!id) return { error: [400, 'Expense category id must be a positive integer.'] };

  const result = await pool.query(
    `SELECT *
     FROM expense_categories
     WHERE id = $1 AND company_id = $2`,
    [id, companyResult.companyId]
  );

  if (!result.rows[0]) {
    return { error: [404, 'Expense category not found.'] };
  }

  return {
    expense_category: mapExpenseCategoryRow(result.rows[0]),
  };
}

function stripCompanyIdFromBody(body = {}) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = { ...body };
  delete sanitized.company_id;
  delete sanitized.companyId;
  return sanitized;
}

async function updateExpenseCategory(authUser, categoryId, body = {}) {
  const id = parsePositiveInt(categoryId);
  if (!id) return { error: [400, 'Expense category id must be a positive integer.'] };

  const companyResult = resolveCompanyIdFromAuth(authUser);
  if (companyResult.error) return { error: companyResult.error };

  const payload = stripCompanyIdFromBody(body);

  const allowedKeys = new Set([
    'name',
    'code',
    'description',
    'paid_in',
    'effective_from',
    'status',
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      return { error: [400, `Unknown field "${key}".`] };
    }
  }

  const hasName = Object.prototype.hasOwnProperty.call(payload, 'name');
  const hasCode = Object.prototype.hasOwnProperty.call(payload, 'code');
  const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description');
  const hasPaidIn = Object.prototype.hasOwnProperty.call(payload, 'paid_in');
  const hasEffectiveFrom = Object.prototype.hasOwnProperty.call(payload, 'effective_from');
  const hasStatus = Object.prototype.hasOwnProperty.call(payload, 'status');

  if (!hasName && !hasCode && !hasDescription && !hasPaidIn && !hasEffectiveFrom && !hasStatus) {
    return { error: [400, 'Provide at least one field to update.'] };
  }

  let nextName;
  if (hasName) {
    const nameResult = normalizeName(payload.name);
    if (nameResult.error) return { error: [400, nameResult.error] };
    nextName = nameResult.name;
  }

  let nextCode;
  if (hasCode) {
    const codeResult = normalizeOptionalCode(payload.code);
    if (codeResult.error) return { error: [400, codeResult.error] };
    nextCode = codeResult.code;
  }

  let nextDescription;
  if (hasDescription) {
    const descriptionResult = normalizeOptionalDescription(payload.description);
    if (descriptionResult.error) return { error: [400, descriptionResult.error] };
    nextDescription = descriptionResult.description;
  }

  let nextPaidIn;
  if (hasPaidIn) {
    const paidInResult = normalizePaidIn(payload.paid_in, { required: true });
    if (paidInResult.error) return { error: [400, paidInResult.error] };
    nextPaidIn = paidInResult.paidIn;
  }

  let nextEffectiveFrom;
  if (hasEffectiveFrom) {
    const effectiveFromResult = normalizeEffectiveFrom(payload.effective_from, { required: true });
    if (effectiveFromResult.error) return { error: [400, effectiveFromResult.error] };
    nextEffectiveFrom = effectiveFromResult.effectiveFrom;
  }

  let nextStatus;
  if (hasStatus) {
    const statusResult = normalizeStatus(payload.status);
    if (statusResult.error) return { error: [400, statusResult.error] };
    nextStatus = statusResult.status;
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (hasName) {
    updates.push(`name = $${idx++}`);
    values.push(nextName);
  }
  if (hasCode) {
    updates.push(`code = $${idx++}`);
    values.push(nextCode);
  }
  if (hasDescription) {
    updates.push(`description = $${idx++}`);
    values.push(nextDescription);
  }
  if (hasPaidIn) {
    updates.push(`paid_in = $${idx++}`);
    values.push(nextPaidIn);
  }
  if (hasEffectiveFrom) {
    updates.push(`effective_from = $${idx++}::date`);
    values.push(nextEffectiveFrom);
  }
  if (hasStatus) {
    updates.push(`status = $${idx++}`);
    values.push(nextStatus);
  }

  const nowUtc = utcNowForPgTimestamp();
  updates.push(`updated_at = $${idx++}::timestamp`);
  values.push(nowUtc);
  values.push(id, companyResult.companyId);

  const updated = await pool.query(
    `UPDATE expense_categories
     SET ${updates.join(', ')}
     WHERE id = $${idx} AND company_id = $${idx + 1}
     RETURNING *`,
    values
  );

  if (!updated.rows[0]) {
    return { error: [404, 'Expense category not found.'] };
  }

  return {
    expense_category: mapExpenseCategoryRow(updated.rows[0]),
  };
}

async function deleteExpenseCategory(authUser, categoryId) {
  const companyResult = resolveCompanyIdFromAuth(authUser);
  if (companyResult.error) return { error: companyResult.error };

  const id = parsePositiveInt(categoryId);
  if (!id) return { error: [400, 'Expense category id must be a positive integer.'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, name
       FROM expense_categories
       WHERE id = $1 AND company_id = $2`,
      [id, companyResult.companyId]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { error: [404, 'Expense category not found.'] };
    }

    await client.query(
      `UPDATE expense_request_details erd
       SET category_id = NULL,
           category = COALESCE(NULLIF(TRIM(erd.category), ''), $2)
       WHERE erd.category_id = $1`,
      [id, existing.rows[0].name]
    );

    const deleted = await client.query(
      `DELETE FROM expense_categories
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, companyResult.companyId]
    );

    await client.query('COMMIT');

    return {
      expense_category: mapExpenseCategoryRow(deleted.rows[0]),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertActiveCategoryForCompany(client, categoryId, companyId, options = {}) {
  const asOf = options.asOf || toDateKey(new Date());
  const result = await client.query(
    `SELECT id, name, status, paid_in, effective_from
     FROM expense_categories
     WHERE id = $1 AND company_id = $2`,
    [categoryId, companyId]
  );
  const row = result.rows[0];
  if (!row) {
    return { error: 'Expense category not found for this company.' };
  }
  if (row.status !== 'active') {
    return { error: 'Expense category is inactive.' };
  }
  const effectiveFrom = toDateKey(row.effective_from);
  if (effectiveFrom && asOf && effectiveFrom > asOf) {
    return {
      error: `Expense category is not effective until ${effectiveFrom}.`,
    };
  }
  return {
    categoryId: Number(row.id),
    categoryName: row.name,
    paidIn: row.paid_in || 'salary',
    effectiveFrom,
  };
}

async function resolvePaidInForExpenseRequest(client, requestId, paidInOverride) {
  if (paidInOverride !== undefined && paidInOverride !== null && String(paidInOverride).trim() !== '') {
    const paidInResult = normalizePaidIn(paidInOverride, { required: true });
    if (paidInResult.error) {
      return { error: paidInResult.error };
    }
    return { paidIn: paidInResult.paidIn, from_category: false };
  }

  const result = await client.query(
    `SELECT ec.paid_in
     FROM expense_request_details erd
     LEFT JOIN expense_categories ec ON ec.id = erd.category_id
     WHERE erd.request_id = $1`,
    [requestId]
  );
  const categoryPaidIn = result.rows[0]?.paid_in;
  if (!categoryPaidIn || !PAID_IN_VALUES.has(String(categoryPaidIn).toLowerCase())) {
    return {
      error: 'paid_in is required (category has no Paid In default). Provide salary or cash.',
    };
  }
  return { paidIn: String(categoryPaidIn).toLowerCase(), from_category: true };
}

module.exports = {
  parsePositiveInt,
  createExpenseCategory,
  getExpenseCategories,
  getExpenseCategoryById,
  updateExpenseCategory,
  deleteExpenseCategory,
  assertActiveCategoryForCompany,
  resolvePaidInForExpenseRequest,
  normalizePaidIn,
  PAID_IN_VALUES,
};
