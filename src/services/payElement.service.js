const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta, parseBooleanQuery } = require('./pagination.service');

const VALID_KINDS = new Set(['allowance', 'deduction', 'contribution']);
const VALID_CALC_TYPES = new Set(['fixed', 'percent_of_basic']);
const VALID_BASED_ON = new Set(['fixed', 'present_days']);
const MAX_BULK_PAY_ELEMENTS = 50;

const COLUMNS = `id, company_id, kind, name, payslip_name, category, calc_type,
  calc_value, based_on, is_taxable, is_active, created_at, updated_at`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    kind: row.kind,
    name: row.name,
    payslip_name: row.payslip_name,
    category: row.category,
    calc_type: row.calc_type,
    calc_value: parseFloat(row.calc_value),
    based_on: row.based_on,
    is_taxable: Boolean(row.is_taxable),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getAuthenticatedCompanyAdmin(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const admin = result.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active || !admin.company_id) {
    return { error: [403, 'Your account must be active and linked to a company.'] };
  }
  return { admin };
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parsePayElementInput(body, kind, { isCreate = false } = {}) {
  const errors = [];

  // name
  if (isCreate || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim();
    if (!name) errors.push('name is required.');
    else if (name.length > 120) errors.push('name must be at most 120 characters.');
    else if (name.length < 2) errors.push('name must be at least 2 characters.');
  } else if (isCreate) {
    errors.push('name is required.');
  }

  // payslip_name
  if (isCreate || body?.payslip_name !== undefined) {
    const payslipName = String(body?.payslip_name ?? '').trim();
    if (!payslipName) errors.push('payslip_name is required.');
    else if (payslipName.length > 120) errors.push('payslip_name must be at most 120 characters.');
  } else if (isCreate) {
    errors.push('payslip_name is required.');
  }

  // calc_type
  if (isCreate || body?.calc_type !== undefined) {
    const calcType = String(body?.calc_type ?? '').trim();
    if (!calcType) errors.push('calc_type is required.');
    else if (!VALID_CALC_TYPES.has(calcType)) {
      errors.push('calc_type must be "fixed" or "percent_of_basic".');
    }
  } else if (isCreate) {
    errors.push('calc_type is required.');
  }

  // calc_value
  let calcValue = null;
  if (isCreate || body?.calc_value !== undefined) {
    calcValue = parseFloat(body?.calc_value);
    if (isNaN(calcValue)) {
      errors.push('calc_value must be a valid number.');
    } else if (calcValue < 0) {
      return { error: [400, 'calc_value cannot be negative.'] };
    }
  } else if (isCreate) {
    errors.push('calc_value is required.');
  }

  // based_on - EC*.4: only valid for allowance
  let basedOn = 'fixed';
  if (isCreate || body?.based_on !== undefined) {
    basedOn = String(body?.based_on ?? 'fixed').trim();
    if (!VALID_BASED_ON.has(basedOn)) {
      errors.push('based_on must be "fixed" or "present_days".');
    } else if (basedOn === 'present_days' && kind !== 'allowance') {
      return { error: [400, 'based_on=present_days is only valid for allowances.'] }; 
    }
  }

  // category - only relevant for allowances, optional
  const category = isCreate || body?.category !== undefined
    ? (body?.category ? String(body?.category).trim() : null)
    : null;

  // is_taxable - default true
  let isTaxable = true;
  if (body?.is_taxable !== undefined) {
    if (body.is_taxable === true || body.is_taxable === 'true') isTaxable = true;
    else if (body.is_taxable === false || body.is_taxable === 'false') isTaxable = false;
    else errors.push('is_taxable must be true or false.');
  }

  // is_active - default true
  let isActive = true;
  if (body?.is_active !== undefined) {
    if (body.is_active === true || body.is_active === 'true') isActive = true;
    else if (body.is_active === false || body.is_active === 'false') isActive = false;
    else errors.push('is_active must be true or false.');
  }

  if (errors.length > 0) {
    return { error: [400, errors.join(' ')] };
  }

  return {
    value: {
      name: String(body.name).trim(),
      payslip_name: String(body.payslip_name).trim(),
      calc_type: String(body.calc_type).trim(),
      calc_value: calcValue,
      based_on: basedOn,
      category,
      is_taxable: isTaxable,
      is_active: isActive,
    },
  };
}

async function fetchById(id, companyId, kind) {
  const result = await pool.query(
    `SELECT ${COLUMNS}
     FROM pay_elements
     WHERE id = $1 AND company_id = $2 AND kind = $3`,
    [id, companyId, kind]
  );
  return result.rows[0] || null;
}

async function create(authUser, kind, body) {
  // Validate kind
  if (!VALID_KINDS.has(kind)) {
    return { error: [400, 'Invalid kind. Must be allowance, deduction, or contribution.'] };
  }

  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const parsed = parsePayElementInput(body, kind, { isCreate: true });
  if (parsed.error) return parsed;

  const input = parsed.value;

  // EC2.1: warn if percent > 100 (but allow it)
  let warning = null;
  if (input.calc_type === 'percent_of_basic' && input.calc_value > 100) {
    warning = 'Warning: percentage exceeds 100%.';
  }

  try {
    const insert = await pool.query(
      `INSERT INTO pay_elements (
         company_id, kind, name, payslip_name, category, calc_type,
         calc_value, based_on, is_taxable, is_active, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING ${COLUMNS}`,
      [
        companyId,
        kind,
        input.name,
        input.payslip_name,
        input.category,
        input.calc_type,
        input.calc_value,
        input.based_on,
        input.is_taxable,
        input.is_active,
      ]
    );

    const result = { payElement: mapRow(insert.rows[0]) };
    if (warning) result.warning = warning;
    return result;
  } catch (error) {
    if (error?.code === '23505') {
      return { error: [409, 'A pay element with this name already exists for this company and kind.'] };
    }
    throw error;
  }
}

async function list(authUser, kind, query = {}) {
  if (!VALID_KINDS.has(kind)) {
    return { error: [400, 'Invalid kind. Must be allowance, deduction, or contribution.'] };
  }

  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;

  let isActiveFilter = null;
  if (query?.is_active !== undefined && query?.is_active !== null && query?.is_active !== '') {
    const parsedActive = parseBooleanQuery(query.is_active, true);
    if (parsedActive === null) return { error: [400, 'is_active must be true or false.'] };
    isActiveFilter = parsedActive;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM pay_elements
     WHERE company_id = $1 AND kind = $2
       AND ($3::text = '' OR name ILIKE $3)
       AND ($4::boolean IS NULL OR is_active = $4)`,
    [companyId, kind, hasSearch ? searchLike : '', isActiveFilter]
  );

  const result = listPagination.noPagination
    ? await pool.query(
        `SELECT ${COLUMNS}
         FROM pay_elements
         WHERE company_id = $1 AND kind = $2
           AND ($3::text = '' OR name ILIKE $3)
           AND ($4::boolean IS NULL OR is_active = $4)
         ORDER BY created_at DESC`,
        [companyId, kind, hasSearch ? searchLike : '', isActiveFilter]
      )
    : await pool.query(
        `SELECT ${COLUMNS}
         FROM pay_elements
         WHERE company_id = $1 AND kind = $2
           AND ($3::text = '' OR name ILIKE $3)
           AND ($4::boolean IS NULL OR is_active = $4)
         ORDER BY created_at DESC
         LIMIT $5 OFFSET $6`,
        [companyId, kind, hasSearch ? searchLike : '', isActiveFilter, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    payElements: result.rows.map(mapRow),
    pagination: buildListPaginationMeta(countResult.rows[0].total, listPagination),
  };
}

async function update(authUser, kind, id, body) {
  if (!VALID_KINDS.has(kind)) {
    return { error: [400, 'Invalid kind. Must be allowance, deduction, or contribution.'] };
  }

  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const elementId = parsePositiveInt(id);
  if (!elementId) return { error: [400, 'Pay element id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchById(elementId, companyId, kind);
  if (!existing) return { error: [404, 'Pay element not found.'] };

  // Filter allowed keys
  const allowedKeys = new Set([
    'name', 'payslip_name', 'category', 'calc_type', 'calc_value',
    'based_on', 'is_taxable', 'is_active',
  ]);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }
  if (Object.keys(body || {}).length === 0) {
    return { error: [400, 'Provide at least one field to update.'] };
  }

  // Validate based_on for non-allowance
  if (body?.based_on !== undefined && kind !== 'allowance') {
    return { error: [400, 'based_on=present_days is only valid for allowances.'] };
  }

  // Validate calc_value >= 0
  if (body?.calc_value !== undefined) {
    const calcValue = parseFloat(body.calc_value);
    if (isNaN(calcValue) || calcValue < 0) {
      return { error: [400, 'calc_value cannot be negative.'] };
    }
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return { error: [400, 'name cannot be empty.'] };
    if (name.length > 120) return { error: [400, 'name must be at most 120 characters.'] };
    updates.push(`name = $${idx++}`);
    values.push(name);
  }

  if (body.payslip_name !== undefined) {
    const payslipName = String(body.payslip_name).trim();
    if (!payslipName) return { error: [400, 'payslip_name cannot be empty.'] };
    if (payslipName.length > 120) return { error: [400, 'payslip_name must be at most 120 characters.'] };
    updates.push(`payslip_name = $${idx++}`);
    values.push(payslipName);
  }

  if (body.category !== undefined) {
    updates.push(`category = $${idx++}`);
    values.push(body.category ? String(body.category).trim() : null);
  }

  if (body.calc_type !== undefined) {
    const calcType = String(body.calc_type).trim();
    if (!VALID_CALC_TYPES.has(calcType)) {
      return { error: [400, 'calc_type must be "fixed" or "percent_of_basic".'] };
    }
    updates.push(`calc_type = $${idx++}`);
    values.push(calcType);
  }

  if (body.calc_value !== undefined) {
    updates.push(`calc_value = $${idx++}`);
    values.push(parseFloat(body.calc_value));
  }

  if (body.based_on !== undefined) {
    const basedOn = String(body.based_on).trim();
    if (!VALID_BASED_ON.has(basedOn)) {
      return { error: [400, 'based_on must be "fixed" or "present_days".'] };
    }
    updates.push(`based_on = $${idx++}`);
    values.push(basedOn);
  }

  if (body.is_taxable !== undefined) {
    updates.push(`is_taxable = $${idx++}`);
    values.push(body.is_taxable === true || body.is_taxable === 'true');
  }

  if (body.is_active !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(body.is_active === true || body.is_active === 'true');
  }

  updates.push('updated_at = NOW()');
  values.push(elementId, companyId, kind);

  let warning = null;
  if (body.calc_type === 'percent_of_basic' || (body.calc_value !== undefined && existing.calc_type === 'percent_of_basic')) {
    const calcValue = body.calc_value !== undefined ? parseFloat(body.calc_value) : parseFloat(existing.calc_value);
    if (calcValue > 100) {
      warning = 'Warning: percentage exceeds 100%.';
    }
  }

  try {
    const updated = await pool.query(
      `UPDATE pay_elements
       SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx++} AND kind = $${idx}
       RETURNING ${COLUMNS}`,
      values
    );

    const result = { payElement: mapRow(updated.rows[0]) };
    if (warning) result.warning = warning;
    return result;
  } catch (error) {
    if (error?.code === '23505') {
      return { error: [409, 'A pay element with this name already exists for this company and kind.'] };
    }
    throw error;
  }
}

async function remove(authUser, kind, id) {
  if (!VALID_KINDS.has(kind)) {
    return { error: [400, 'Invalid kind. Must be allowance, deduction, or contribution.'] };
  }

  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const elementId = parsePositiveInt(id);
  if (!elementId) return { error: [400, 'Pay element id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);

  try {
    const deleted = await pool.query(
      `DELETE FROM pay_elements
       WHERE id = $1 AND company_id = $2 AND kind = $3
       RETURNING ${COLUMNS}`,
      [elementId, companyId, kind]
    );

    if (deleted.rowCount === 0) {
      return { error: [404, 'Pay element not found.'] };
    }

    return { payElement: mapRow(deleted.rows[0]) };
  } catch (error) {
    if (error?.code === '23503') {
      return { error: [409, 'Cannot delete: pay element is referenced by other records.'] };
    }
    throw error;
  }
}

async function bulkImport(authUser, kind, body = {}) {
  if (!VALID_KINDS.has(kind)) {
    return { error: [400, 'Invalid kind. Must be allowance, deduction, or contribution.'] };
  }

  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const rows = Array.isArray(body.rows) ? body.rows : null;

  if (!rows || rows.length === 0) {
    return { error: [400, 'rows must be a non-empty array.'] };
  }
  if (rows.length > MAX_BULK_PAY_ELEMENTS) {
    return {
      error: [400, `Maximum ${MAX_BULK_PAY_ELEMENTS} pay elements per import request.`],
    };
  }

  const validRows = [];
  const rowErrors = [];
  const seenNames = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const parsed = parsePayElementInput(rows[i] || {}, kind, { isCreate: true });
    if (parsed.error) {
      rowErrors.push({ row_index: i, reason: parsed.error[1] });
      continue;
    }

    const nameKey = parsed.value.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      rowErrors.push({
        row_index: i,
        reason: `Duplicate name "${parsed.value.name}" in import file (also at row ${seenNames.get(nameKey) + 1}).`,
      });
      continue;
    }

    seenNames.set(nameKey, i);
    validRows.push({ row_index: i, ...parsed.value });
  }

  if (rowErrors.length > 0) {
    return {
      error: [
        400,
        `Import rejected: ${rowErrors.length} invalid row(s). No rows were saved.`,
        {
          errors: rowErrors,
          valid_count: validRows.length,
          invalid_count: rowErrors.length,
        },
      ],
    };
  }

  if (validRows.length > 0) {
    const nameKeys = validRows.map((row) => row.name.toLowerCase());
    const existingResult = await pool.query(
      `SELECT LOWER(name) AS name_lower, name
       FROM pay_elements
       WHERE company_id = $1 AND kind = $2 AND LOWER(name) = ANY($3::text[])`,
      [companyId, kind, nameKeys]
    );
    const existingByLower = new Map(
      existingResult.rows.map((row) => [row.name_lower, row.name])
    );

    for (const row of validRows) {
      const existingName = existingByLower.get(row.name.toLowerCase());
      if (existingName) {
        rowErrors.push({
          row_index: row.row_index,
          reason: `A ${kind} named "${existingName}" already exists for this company.`,
        });
      }
    }
  }

  if (rowErrors.length > 0) {
    return {
      error: [
        409,
        `Import rejected: ${rowErrors.length} row(s) conflict with existing data. No rows were saved.`,
        {
          errors: rowErrors,
          valid_count: 0,
          invalid_count: rowErrors.length,
        },
      ],
    };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const created = [];
    const warnings = [];

    for (const row of validRows) {
      if (row.calc_type === 'percent_of_basic' && row.calc_value > 100) {
        warnings.push(`Row ${row.row_index + 1}: percentage exceeds 100% for "${row.name}".`);
      }

      const insert = await client.query(
        `INSERT INTO pay_elements (
           company_id, kind, name, payslip_name, category, calc_type,
           calc_value, based_on, is_taxable, is_active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         RETURNING ${COLUMNS}`,
        [
          companyId,
          kind,
          row.name,
          row.payslip_name,
          row.category,
          row.calc_type,
          row.calc_value,
          row.based_on,
          row.is_taxable,
          row.is_active,
        ]
      );
      created.push(mapRow(insert.rows[0]));
    }

    await client.query('COMMIT');

    const result = {
      count: created.length,
      payElements: created,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error?.code === '23505') {
      return {
        error: [
          409,
          'Import rejected: a pay element with this name already exists for this company and kind.',
          {
            errors: [{ row_index: 0, reason: 'A pay element with this name already exists.' }],
          },
        ],
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

// Thin wrappers for each kind
function createAllowance(authUser, body) {
  return create(authUser, 'allowance', body);
}
function listAllowances(authUser, query) {
  return list(authUser, 'allowance', query);
}
function updateAllowance(authUser, id, body) {
  return update(authUser, 'allowance', id, body);
}
function deleteAllowance(authUser, id) {
  return remove(authUser, 'allowance', id);
}
function bulkImportAllowances(authUser, body) {
  return bulkImport(authUser, 'allowance', body);
}

function createDeduction(authUser, body) {
  return create(authUser, 'deduction', body);
}
function listDeductions(authUser, query) {
  return list(authUser, 'deduction', query);
}
function updateDeduction(authUser, id, body) {
  return update(authUser, 'deduction', id, body);
}
function deleteDeduction(authUser, id) {
  return remove(authUser, 'deduction', id);
}
function bulkImportDeductions(authUser, body) {
  return bulkImport(authUser, 'deduction', body);
}

function createContribution(authUser, body) {
  return create(authUser, 'contribution', body);
}
function listContributions(authUser, query) {
  return list(authUser, 'contribution', query);
}
function updateContribution(authUser, id, body) {
  return update(authUser, 'contribution', id, body);
}
function deleteContribution(authUser, id) {
  return remove(authUser, 'contribution', id);
}
function bulkImportContributions(authUser, body) {
  return bulkImport(authUser, 'contribution', body);
}

module.exports = {
  create,
  list,
  update,
  remove,
  bulkImport,
  createAllowance,
  listAllowances,
  updateAllowance,
  deleteAllowance,
  bulkImportAllowances,
  createDeduction,
  listDeductions,
  updateDeduction,
  deleteDeduction,
  bulkImportDeductions,
  createContribution,
  listContributions,
  updateContribution,
  deleteContribution,
  bulkImportContributions,
  getAuthenticatedCompanyAdmin,
  parsePositiveInt,
  VALID_KINDS,
  VALID_CALC_TYPES,
  VALID_BASED_ON,
};
