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

function mapDocumentTypeRow(row) {
  const id = serializeRowId(row?.id);
  const company_id = serializeRowId(row?.company_id);
  return {
    id,
    document_type_id: id,
    company_id,
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    value: row.value,
    label: row.label,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

const companyJoinSelect = `SELECT dt.*,
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
       FROM document_types dt
       JOIN companies c ON c.id = dt.company_id`;

async function fetchWithCompany(typeId) {
  const r = await pool.query(`${companyJoinSelect} WHERE dt.id = $1`, [typeId]);
  return r.rows[0] || null;
}

/** POST /api/v1/document-types */
async function createDocumentType(req, res) {
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
      `INSERT INTO document_types (company_id, value, label, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamp, $4::timestamp)
       RETURNING *`,
      [companyId, val.value, lab.label, nowUtc]
    );

    const row = await fetchWithCompany(insert.rows[0].id);
    return sendSuccess(res, 201, 'Document type created successfully.', {
      document_type: mapDocumentTypeRow(row || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A document type with this value already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createDocumentType error:', error);
    return sendError(res, 500, 'Something went wrong while creating document type.');
  }
}

/** GET /api/v1/document-types?company_id= */
async function getDocumentTypes(req, res) {
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
       FROM document_types
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
       WHERE dt.company_id = $1
         AND (
           $2::text = ''
           OR dt.label ILIKE $2
           OR COALESCE(dt.value, '') ILIKE $2
         )
       ORDER BY dt.value ASC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `${companyJoinSelect}
       WHERE dt.company_id = $1
         AND (
           $2::text = ''
           OR dt.label ILIKE $2
           OR COALESCE(dt.value, '') ILIKE $2
         )
       ORDER BY dt.value ASC
       LIMIT $3 OFFSET $4`,
          [
            companyId,
            hasSearch ? searchLike : '',
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    return sendSuccess(res, 200, 'Document types fetched successfully.', {
      document_types: result.rows.map(mapDocumentTypeRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getDocumentTypes error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document types.');
  }
}

/** GET /api/v1/document-types/:id?company_id= */
async function getDocumentTypeById(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Document type id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(`${companyJoinSelect} WHERE dt.id = $1 AND dt.company_id = $2`, [
      typeId,
      companyId,
    ]);

    if (result.rowCount === 0) return sendError(res, 404, 'Document type not found.');
    return sendSuccess(res, 200, 'Document type fetched successfully.', {
      document_type: mapDocumentTypeRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getDocumentTypeById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching document type.');
  }
}

/** PATCH /api/v1/document-types/:id */
async function updateDocumentType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!typeId) return sendError(res, 400, 'Document type id must be a positive integer.');
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
      `UPDATE document_types
       SET ${updates.join(', ')}
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Document type not found.');

    const row = await fetchWithCompany(updated.rows[0].id);
    return sendSuccess(res, 200, 'Document type updated successfully.', {
      document_type: mapDocumentTypeRow(row || updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A document type with this value already exists for this company.');
    }
    console.error('updateDocumentType error:', error);
    return sendError(res, 500, 'Something went wrong while updating document type.');
  }
}

/** DELETE /api/v1/document-types/:id?company_id= */
async function deleteDocumentType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!typeId) return sendError(res, 400, 'Document type id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM document_types WHERE id = $1 AND company_id = $2 RETURNING *`,
      [typeId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Document type not found.');

    return sendSuccess(res, 200, 'Document type deleted successfully.', {
      document_type: mapDocumentTypeRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteDocumentType error:', error);
    return sendError(res, 500, 'Something went wrong while deleting document type.');
  }
}

module.exports = {
  createDocumentType,
  getDocumentTypes,
  getDocumentTypeById,
  updateDocumentType,
  deleteDocumentType,
};
