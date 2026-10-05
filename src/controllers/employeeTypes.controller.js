const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');

const VALUE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeTypeValue(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return { error: 'value is required.' };
  if (!VALUE_PATTERN.test(s)) {
    return {
      error:
        'value must be 1–50 characters: start with a letter, then lowercase letters, digits, or underscores only.',
    };
  }
  return { value: s };
}

function normalizeLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'label is required.' };
  if (s.length > 120) return { error: 'label must be at most 120 characters.' };
  return { label: s };
}

function mapEmployeeTypeRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    value: row.value,
    label: row.label,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

/** Public: no $1 role param — literal role in SQL for subqueries. */
const companyJoinSelect = `SELECT et.*,
              c.name AS company_name,
              COALESCE(
                (
                  SELECT u.email
                  FROM users u
                  WHERE u.company_id = c.id
                    AND u.role = 'company_admin'
                  ORDER BY u.id ASC
                  LIMIT 1
                ),
                (
                  SELECT owner.email
                  FROM users owner
                  WHERE owner.id = c.super_admin_id
                  LIMIT 1
                )
              ) AS company_admin_email
       FROM employee_types et
       JOIN companies c ON c.id = et.company_id`;

async function fetchTypeWithCompany(typeId) {
  const r = await pool.query(`${companyJoinSelect} WHERE et.id = $1`, [typeId]);
  return r.rows[0] || null;
}

/** POST /api/v1/employee-types — public */
async function createEmployeeType(req, res) {
  const { company_id, value, label } = req.body || {};
  const companyId = parsePositiveInt(company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const val = normalizeTypeValue(value);
  if (val.error) return sendError(res, 400, val.error);
  const lab = normalizeLabel(label);
  if (lab.error) return sendError(res, 400, lab.error);

  try {
    const nowUtc = utcNowForPgTimestamp();
    const insert = await pool.query(
      `INSERT INTO employee_types (company_id, value, label, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamp, $4::timestamp)
       RETURNING *`,
      [companyId, val.value, lab.label, nowUtc]
    );

    const row = await fetchTypeWithCompany(insert.rows[0].id);
    return sendSuccess(res, 201, 'Employee type created successfully.', {
      employee_type: mapEmployeeTypeRow(row || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'An employee type with this value already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createEmployeeType error:', error);
    return sendError(res, 500, 'Something went wrong while creating employee type.');
  }
}

/** GET /api/v1/employee-types?company_id= — public */
async function getEmployeeTypes(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM employee_types
       WHERE company_id = $1
         AND (
           $2::text = ''
           OR label ILIKE $2
           OR COALESCE(value, '') ILIKE $2
         )`,
      [companyId, hasSearch ? searchLike : '']
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `${companyJoinSelect}
       WHERE et.company_id = $1
         AND (
           $2::text = ''
           OR et.label ILIKE $2
           OR COALESCE(et.value, '') ILIKE $2
         )
       ORDER BY et.value ASC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `${companyJoinSelect}
       WHERE et.company_id = $1
         AND (
           $2::text = ''
           OR et.label ILIKE $2
           OR COALESCE(et.value, '') ILIKE $2
         )
       ORDER BY et.value ASC
       LIMIT $3 OFFSET $4`,
          [
            companyId,
            hasSearch ? searchLike : '',
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    return sendSuccess(res, 200, 'Employee types fetched successfully.', {
      employee_types: result.rows.map(mapEmployeeTypeRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getEmployeeTypes error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee types.');
  }
}

/** GET /api/v1/employee-types/:id?company_id= — public; company_id required */
async function getEmployeeTypeById(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Employee type id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(`${companyJoinSelect} WHERE et.id = $1 AND et.company_id = $2`, [
      typeId,
      companyId,
    ]);

    if (result.rowCount === 0) return sendError(res, 404, 'Employee type not found.');
    return sendSuccess(res, 200, 'Employee type fetched successfully.', {
      employee_type: mapEmployeeTypeRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getEmployeeTypeById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee type.');
  }
}

/** PATCH /api/v1/employee-types/:id — public */
async function updateEmployeeType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!typeId) return sendError(res, 400, 'Employee type id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set(['company_id', 'value', 'label']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return sendError(res, 400, `Unknown field "${key}".`);
    }
  }

  const hasValue = Object.prototype.hasOwnProperty.call(body, 'value');
  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');
  if (!hasValue && !hasLabel) {
    return sendError(res, 400, 'Provide value and/or label to update.');
  }

  let nextValue;
  if (hasValue) {
    const v = normalizeTypeValue(body.value);
    if (v.error) return sendError(res, 400, v.error);
    nextValue = v.value;
  }
  let nextLabel;
  if (hasLabel) {
    const l = normalizeLabel(body.label);
    if (l.error) return sendError(res, 400, l.error);
    nextLabel = l.label;
  }

  try {
    const updates = [];
    const values = [];
    let idx = 1;
    if (hasValue) {
      updates.push(`value = $${idx++}`);
      values.push(nextValue);
    }
    if (hasLabel) {
      updates.push(`label = $${idx++}`);
      values.push(nextLabel);
    }
    const nowUtc = utcNowForPgTimestamp();
    updates.push(`updated_at = $${idx++}::timestamp`);
    values.push(nowUtc);
    values.push(typeId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE employee_types
       SET ${updates.join(', ')}
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Employee type not found.');

    const row = await fetchTypeWithCompany(updated.rows[0].id);
    return sendSuccess(res, 200, 'Employee type updated successfully.', {
      employee_type: mapEmployeeTypeRow(row || updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'An employee type with this value already exists for this company.');
    }
    console.error('updateEmployeeType error:', error);
    return sendError(res, 500, 'Something went wrong while updating employee type.');
  }
}

/** DELETE /api/v1/employee-types/:id?company_id= — public */
async function deleteEmployeeType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!typeId) return sendError(res, 400, 'Employee type id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM employee_types WHERE id = $1 AND company_id = $2 RETURNING *`,
      [typeId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Employee type not found.');

    return sendSuccess(res, 200, 'Employee type deleted successfully.', {
      employee_type: mapEmployeeTypeRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteEmployeeType error:', error);
    return sendError(res, 500, 'Something went wrong while deleting employee type.');
  }
}

module.exports = {
  createEmployeeType,
  getEmployeeTypes,
  getEmployeeTypeById,
  updateEmployeeType,
  deleteEmployeeType,
};
