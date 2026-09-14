const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');

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

/** Accept `value` or legacy `payroll_type` as the type slug. */
function resolveValueFromBody(body) {
  if (body.value !== undefined && body.value !== null && String(body.value).trim() !== '') {
    return normalizeTypeValue(body.value);
  }
  if (body.payroll_type !== undefined && body.payroll_type !== null && String(body.payroll_type).trim() !== '') {
    return normalizeTypeValue(body.payroll_type);
  }
  return { error: 'value is required.' };
}

function mapSalaryTypeRow(row) {
  const value = row.value ?? row.payroll_type ?? null;
  const label =
    row.label ??
    (value ? String(value).charAt(0).toUpperCase() + String(value).slice(1).toLowerCase() : null);
  return {
    id: Number(row.id),
    salary_type_id: Number(row.id),
    company_id: Number(row.company_id),
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    value,
    label,
    /** @deprecated use `value` */
    payroll_type: value,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

const companyJoinSelect = `SELECT se.*,
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
       FROM salary_entries se
       JOIN companies c ON c.id = se.company_id`;

async function fetchWithCompany(typeId) {
  const r = await pool.query(`${companyJoinSelect} WHERE se.id = $1`, [typeId]);
  return r.rows[0] || null;
}

/** GET /api/v1/salaries/payroll-types — default options (monthly / hourly) */
async function getPayrollTypes(req, res) {
  try {
    return sendSuccess(res, 200, 'Salary types fetched successfully.', {
      payroll_types: [
        { value: 'monthly', label: 'Monthly' },
        { value: 'hourly', label: 'Hourly' },
      ],
      salary_types: [
        { value: 'monthly', label: 'Monthly' },
        { value: 'hourly', label: 'Hourly' },
      ],
    });
  } catch (error) {
    console.error('getPayrollTypes error:', error);
    return sendError(res, 500, 'Something went wrong while fetching salary types.');
  }
}

/** POST /api/v1/salaries — create company salary type (value + label, no amount) */
async function createSalary(req, res) {
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const val = resolveValueFromBody(body);
  if (val.error) return sendError(res, 400, val.error);
  const lab = normalizeLabel(body.label);
  if (lab.error) return sendError(res, 400, lab.error);

  try {
    const nowUtc = utcNowForPgTimestamp();
    const insert = await pool.query(
      `INSERT INTO salary_entries (company_id, value, label, payroll_type, basic_salary, created_at, updated_at)
       VALUES ($1, $2, $3, $2, NULL, $4::timestamp, $4::timestamp)
       RETURNING *`,
      [companyId, val.value, lab.label, nowUtc]
    );

    const row = await fetchWithCompany(insert.rows[0].id);
    return sendSuccess(res, 201, 'Salary type created successfully.', {
      salary_type: mapSalaryTypeRow(row || insert.rows[0]),
      /** @deprecated use salary_type */
      salary: mapSalaryTypeRow(row || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A salary type with this value already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    if (error?.code === '42703') {
      return sendError(
        res,
        500,
        'Database schema is outdated. Restart the server or run salary_entries migration (value, label columns).'
      );
    }
    console.error('createSalary error:', error);
    return sendError(res, 500, 'Something went wrong while creating salary type.');
  }
}

/** GET /api/v1/salaries?company_id= */
async function getSalaries(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) {
    return sendError(res, 400, listPagination.error);
  }

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM salary_entries
       WHERE company_id = $1
         AND (
           $2::text = ''
           OR COALESCE(label, '') ILIKE $2
           OR COALESCE(value, '') ILIKE $2
           OR COALESCE(payroll_type, '') ILIKE $2
         )`,
      [companyId, hasSearch ? searchLike : '']
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `${companyJoinSelect}
       WHERE se.company_id = $1
         AND (
           $2::text = ''
           OR COALESCE(se.label, '') ILIKE $2
           OR COALESCE(se.value, '') ILIKE $2
           OR COALESCE(se.payroll_type, '') ILIKE $2
         )
       ORDER BY COALESCE(se.value, se.payroll_type) ASC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `${companyJoinSelect}
       WHERE se.company_id = $1
         AND (
           $2::text = ''
           OR COALESCE(se.label, '') ILIKE $2
           OR COALESCE(se.value, '') ILIKE $2
           OR COALESCE(se.payroll_type, '') ILIKE $2
         )
       ORDER BY COALESCE(se.value, se.payroll_type) ASC
       LIMIT $3 OFFSET $4`,
          [
            companyId,
            hasSearch ? searchLike : '',
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    const rows = result.rows.map(mapSalaryTypeRow);
    return sendSuccess(res, 200, 'Salary types fetched successfully.', {
      salary_types: rows,
      /** @deprecated use salary_types */
      salaries: rows,
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getSalaries error:', error);
    return sendError(res, 500, 'Something went wrong while fetching salary types.');
  }
}

/** GET /api/v1/salaries/:id?company_id= */
async function getSalaryById(req, res) {
  const salaryId = parsePositiveInt(req.params.id);
  if (!salaryId) return sendError(res, 400, 'Salary type id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(`${companyJoinSelect} WHERE se.id = $1 AND se.company_id = $2`, [
      salaryId,
      companyId,
    ]);

    if (result.rowCount === 0) return sendError(res, 404, 'Salary type not found.');
    const row = mapSalaryTypeRow(result.rows[0]);
    return sendSuccess(res, 200, 'Salary type fetched successfully.', {
      salary_type: row,
      salary: row,
    });
  } catch (error) {
    console.error('getSalaryById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching salary type.');
  }
}

/** PATCH /api/v1/salaries/:id */
async function updateSalary(req, res) {
  const salaryId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!salaryId) return sendError(res, 400, 'Salary type id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set(['company_id', 'value', 'label', 'payroll_type']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return sendError(res, 400, `Unknown field "${key}". Only value and/or label may be updated.`);
    }
  }

  const hasValue =
    Object.prototype.hasOwnProperty.call(body, 'value') ||
    Object.prototype.hasOwnProperty.call(body, 'payroll_type');
  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');
  if (!hasValue && !hasLabel) {
    return sendError(res, 400, 'Provide value and/or label to update.');
  }

  let nextValue;
  if (hasValue) {
    const v = resolveValueFromBody(body);
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
      updates.push(`payroll_type = $${idx++}`);
      values.push(nextValue);
    }
    if (hasLabel) {
      updates.push(`label = $${idx++}`);
      values.push(nextLabel);
    }
    const nowUtc = utcNowForPgTimestamp();
    updates.push(`updated_at = $${idx++}::timestamp`);
    values.push(nowUtc);
    values.push(salaryId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE salary_entries
       SET ${updates.join(', ')}
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Salary type not found.');

    const row = await fetchWithCompany(updated.rows[0].id);
    const mapped = mapSalaryTypeRow(row || updated.rows[0]);
    return sendSuccess(res, 200, 'Salary type updated successfully.', {
      salary_type: mapped,
      salary: mapped,
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A salary type with this value already exists for this company.');
    }
    console.error('updateSalary error:', error);
    return sendError(res, 500, 'Something went wrong while updating salary type.');
  }
}

/** DELETE /api/v1/salaries/:id?company_id= */
async function deleteSalary(req, res) {
  const salaryId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!salaryId) return sendError(res, 400, 'Salary type id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM salary_entries WHERE id = $1 AND company_id = $2 RETURNING *`,
      [salaryId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Salary type not found.');

    const mapped = mapSalaryTypeRow(deleted.rows[0]);
    return sendSuccess(res, 200, 'Salary type deleted successfully.', {
      salary_type: mapped,
      salary: mapped,
    });
  } catch (error) {
    console.error('deleteSalary error:', error);
    return sendError(res, 500, 'Something went wrong while deleting salary type.');
  }
}

module.exports = {
  getPayrollTypes,
  createSalary,
  getSalaries,
  getSalaryById,
  updateSalary,
  deleteSalary,
};
