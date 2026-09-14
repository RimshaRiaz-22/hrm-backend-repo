const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');

const TRAINING_TYPES = new Set(['video', 'pdf']);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
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

function mapTrainingMaterialRow(row) {
  return {
    id: serializeRowId(row.id),
    training_material_id: serializeRowId(row.id),
    company_id: serializeRowId(row.company_id),
    name: row.name,
    description: row.description,
    type: row.type,
    file_url: row.file_url,
    file_name: row.file_name,
    is_active: row.is_active,
    created_by: serializeRowId(row.created_by),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function validateName(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'name is required.' };
  if (s.length > 255) return { error: 'name must be at most 255 characters.' };
  return { value: s };
}

function validateType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!TRAINING_TYPES.has(s)) return { error: 'type must be "video" or "pdf".' };
  return { value: s };
}

function validateFileUrl(raw) {
  const s = raw ? String(raw).trim() : '';
  if (!s) return { error: 'file_url is required.' };
  return { value: s };
}

/** POST /api/v1/training */
async function createTrainingMaterial(req, res) {
  const body = req.body || {};
  const companyId = req.authUser.companyId;
  if (!companyId) return sendError(res, 400, 'Your account is not linked to any company.');

  const nameResult = validateName(body.name);
  if (nameResult.error) return sendError(res, 400, nameResult.error);
  const typeResult = validateType(body.type);
  if (typeResult.error) return sendError(res, 400, typeResult.error);
  const fileUrlResult = validateFileUrl(body.file_url);
  if (fileUrlResult.error) return sendError(res, 400, fileUrlResult.error);
  const description = body.description !== undefined && body.description !== null ? String(body.description).trim() || null : null;
  const fileName = body.file_name ? String(body.file_name).trim().slice(0, 255) : null;

  try {
    const nowUtc = utcNowForPgTimestamp();
    const insert = await pool.query(
      `INSERT INTO training_materials (
         company_id, name, description, type, file_url, file_name, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $8::timestamp)
       RETURNING *`,
      [companyId, nameResult.value, description, typeResult.value, fileUrlResult.value, fileName, req.authUser.userId, nowUtc]
    );

    return sendSuccess(res, 201, 'Training material created successfully.', {
      training_material: mapTrainingMaterialRow(insert.rows[0]),
    });
  } catch (error) {
    console.error('createTrainingMaterial error:', error);
    return sendError(res, 500, 'Something went wrong while creating the training material.');
  }
}

/** GET /api/v1/training */
async function getTrainingMaterials(req, res) {
  const companyId = req.authUser.companyId;
  if (!companyId) return sendError(res, 400, 'Your account is not linked to any company.');

  const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM training_materials
       WHERE company_id = $1
         AND ($2::text = '' OR name ILIKE $2)`,
      [companyId, hasSearch ? searchLike : '']
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `SELECT * FROM training_materials
           WHERE company_id = $1 AND ($2::text = '' OR name ILIKE $2)
           ORDER BY created_at DESC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `SELECT * FROM training_materials
           WHERE company_id = $1 AND ($2::text = '' OR name ILIKE $2)
           ORDER BY created_at DESC
           LIMIT $3 OFFSET $4`,
          [companyId, hasSearch ? searchLike : '', listPagination.pagination.limit, listPagination.pagination.offset]
        );

    return sendSuccess(res, 200, 'Training materials fetched successfully.', {
      training_materials: result.rows.map(mapTrainingMaterialRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getTrainingMaterials error:', error);
    return sendError(res, 500, 'Something went wrong while fetching training materials.');
  }
}

/** GET /api/v1/training/:id */
async function getTrainingMaterialById(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Training material id must be a positive integer.');
  const companyId = req.authUser.companyId;

  try {
    const result = await pool.query(`SELECT * FROM training_materials WHERE id = $1 AND company_id = $2`, [
      id,
      companyId,
    ]);
    if (result.rowCount === 0) return sendError(res, 404, 'Training material not found.');
    return sendSuccess(res, 200, 'Training material fetched successfully.', {
      training_material: mapTrainingMaterialRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getTrainingMaterialById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching the training material.');
  }
}

/** PATCH /api/v1/training/:id */
async function updateTrainingMaterial(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Training material id must be a positive integer.');
  const companyId = req.authUser.companyId;
  const body = req.body || {};

  const allowedKeys = new Set(['name', 'description', 'type', 'file_url', 'file_name', 'is_active']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return sendError(res, 400, `Unknown field "${key}".`);
  }

  const updates = [];
  const values = [];
  let idx = 1;
  const setColumn = (column, value) => {
    updates.push(`${column} = $${idx++}`);
    values.push(value);
  };

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const r = validateName(body.name);
    if (r.error) return sendError(res, 400, r.error);
    setColumn('name', r.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    setColumn('description', body.description !== null ? String(body.description).trim() || null : null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'type')) {
    const r = validateType(body.type);
    if (r.error) return sendError(res, 400, r.error);
    setColumn('type', r.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'file_url')) {
    const r = validateFileUrl(body.file_url);
    if (r.error) return sendError(res, 400, r.error);
    setColumn('file_url', r.value);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'file_name')) {
    setColumn('file_name', body.file_name ? String(body.file_name).trim().slice(0, 255) : null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    setColumn('is_active', Boolean(body.is_active));
  }

  if (updates.length === 0) {
    return sendError(res, 400, 'Provide at least one field to update.');
  }

  try {
    const nowUtc = utcNowForPgTimestamp();
    updates.push(`updated_at = $${idx++}::timestamp`);
    values.push(nowUtc);
    values.push(id, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE training_materials SET ${updates.join(', ')} WHERE id = $${idPos} AND company_id = $${companyPos} RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Training material not found.');

    return sendSuccess(res, 200, 'Training material updated successfully.', {
      training_material: mapTrainingMaterialRow(updated.rows[0]),
    });
  } catch (error) {
    console.error('updateTrainingMaterial error:', error);
    return sendError(res, 500, 'Something went wrong while updating the training material.');
  }
}

/** DELETE /api/v1/training/:id — soft delete (is_active = false) so past completions stay coherent. */
async function deleteTrainingMaterial(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (!id) return sendError(res, 400, 'Training material id must be a positive integer.');
  const companyId = req.authUser.companyId;

  try {
    const updated = await pool.query(
      `UPDATE training_materials SET is_active = false, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId]
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Training material not found.');

    return sendSuccess(res, 200, 'Training material deleted successfully.', {
      training_material: mapTrainingMaterialRow(updated.rows[0]),
    });
  } catch (error) {
    console.error('deleteTrainingMaterial error:', error);
    return sendError(res, 500, 'Something went wrong while deleting the training material.');
  }
}

module.exports = {
  createTrainingMaterial,
  getTrainingMaterials,
  getTrainingMaterialById,
  updateTrainingMaterial,
  deleteTrainingMaterial,
};
