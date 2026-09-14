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

/** BIGINT from node-pg — JSON-safe number (or string if out of safe range). */
function serializeRowId(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'bigint') {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val.toString();
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : String(val);
}

function mapRoleRow(row) {
  const id = serializeRowId(row?.id);
  const company_id = serializeRowId(row?.company_id);
  return {
    id,
    role_id: id,
    company_id,
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    value: row.value,
    label: row.label,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

const companyJoinSelect = `SELECT er.*,
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
       FROM employee_roles er
       JOIN companies c ON c.id = er.company_id`;

async function fetchWithCompany(roleId) {
  const r = await pool.query(`${companyJoinSelect} WHERE er.id = $1`, [roleId]);
  return r.rows[0] || null;
}

/** POST /api/v1/roles */
async function createRole(req, res) {
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
      `INSERT INTO employee_roles (company_id, value, label, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamp, $4::timestamp)
       RETURNING *`,
      [companyId, val.value, lab.label, nowUtc]
    );

    const row = await fetchWithCompany(insert.rows[0].id);
    return sendSuccess(res, 201, 'Role created successfully.', {
      role: mapRoleRow(row || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A role with this value already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createRole error:', error);
    return sendError(res, 500, 'Something went wrong while creating role.');
  }
}

/** GET /api/v1/roles?company_id= */
async function getRoles(req, res) {
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
       FROM employee_roles
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
       WHERE er.company_id = $1
         AND (
           $2::text = ''
           OR er.label ILIKE $2
           OR COALESCE(er.value, '') ILIKE $2
         )
       ORDER BY er.value ASC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `${companyJoinSelect}
       WHERE er.company_id = $1
         AND (
           $2::text = ''
           OR er.label ILIKE $2
           OR COALESCE(er.value, '') ILIKE $2
         )
       ORDER BY er.value ASC
       LIMIT $3 OFFSET $4`,
          [
            companyId,
            hasSearch ? searchLike : '',
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    return sendSuccess(res, 200, 'Roles fetched successfully.', {
      roles: result.rows.map(mapRoleRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getRoles error:', error);
    return sendError(res, 500, 'Something went wrong while fetching roles.');
  }
}

/** GET /api/v1/roles/:id?company_id= */
async function getRoleById(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(`${companyJoinSelect} WHERE er.id = $1 AND er.company_id = $2`, [
      roleId,
      companyId,
    ]);

    if (result.rowCount === 0) return sendError(res, 404, 'Role not found.');
    return sendSuccess(res, 200, 'Role fetched successfully.', {
      role: mapRoleRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getRoleById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching role.');
  }
}

/** PATCH /api/v1/roles/:id */
async function updateRole(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');
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
    values.push(roleId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE employee_roles
       SET ${updates.join(', ')}
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Role not found.');

    const row = await fetchWithCompany(updated.rows[0].id);
    return sendSuccess(res, 200, 'Role updated successfully.', {
      role: mapRoleRow(row || updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A role with this value already exists for this company.');
    }
    console.error('updateRole error:', error);
    return sendError(res, 500, 'Something went wrong while updating role.');
  }
}

/** DELETE /api/v1/roles/:id?company_id= */
async function deleteRole(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM employee_roles WHERE id = $1 AND company_id = $2 RETURNING *`,
      [roleId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Role not found.');

    return sendSuccess(res, 200, 'Role deleted successfully.', {
      role: mapRoleRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteRole error:', error);
    return sendError(res, 500, 'Something went wrong while deleting role.');
  }
}

module.exports = {
  createRole,
  getRoles,
  getRoleById,
  updateRole,
  deleteRole,
};
