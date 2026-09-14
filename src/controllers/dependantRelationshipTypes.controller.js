const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');

const VALUE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

const DEFAULT_RELATIONSHIP_TYPES = [
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'parent', label: 'Parent' },
  { value: 'sibling', label: 'Sibling' },
];

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

/** Build slug + label from free text (e.g. "Cousin" → cousin). */
function slugifyRelationshipLabel(raw) {
  const label = String(raw || '').trim();
  if (!label) return { error: 'relationship_other is required.' };
  const value = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!value || !/^[a-z]/.test(value)) {
    return {
      error:
        'Custom relationship must start with a letter and use only letters, numbers, or spaces.',
    };
  }
  if (value.length > 50) {
    return { error: 'Custom relationship is too long (max 50 characters as a slug).' };
  }
  return { value, label };
}

function mapRow(row) {
  return {
    id: Number(row.id),
    relationship_type_id: Number(row.id),
    company_id: Number(row.company_id),
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    value: row.value,
    label: row.label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const companyJoinSelect = `SELECT drt.*,
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
       FROM dependant_relationship_types drt
       JOIN companies c ON c.id = drt.company_id`;

async function fetchWithCompany(typeId) {
  const r = await pool.query(`${companyJoinSelect} WHERE drt.id = $1`, [typeId]);
  return r.rows[0] || null;
}

async function relationshipValueExistsForCompany(companyId, value) {
  if (DEFAULT_RELATIONSHIP_TYPES.some((d) => d.value === value)) return true;
  const r = await pool.query(
    `SELECT id FROM dependant_relationship_types WHERE company_id = $1 AND value = $2`,
    [companyId, value]
  );
  return r.rowCount > 0;
}

async function upsertRelationshipType(client, companyId, value, label) {
  const db = client || pool;
  const existing = await db.query(
    `SELECT id FROM dependant_relationship_types WHERE company_id = $1 AND value = $2`,
    [companyId, value]
  );
  if (existing.rowCount > 0) return existing.rows[0].id;
  const insert = await db.query(
    `INSERT INTO dependant_relationship_types (company_id, value, label, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (company_id, value) DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()
     RETURNING id`,
    [companyId, value, label]
  );
  return insert.rows[0].id;
}

/** POST /api/v1/dependant-relationship-types */
async function createDependantRelationshipType(req, res) {
  const { company_id, value, label } = req.body || {};
  const companyId = parsePositiveInt(company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const val = normalizeTypeValue(value);
  if (val.error) return sendError(res, 400, val.error);
  const lab = normalizeLabel(label);
  if (lab.error) return sendError(res, 400, lab.error);

  try {
    const insert = await pool.query(
      `INSERT INTO dependant_relationship_types (company_id, value, label, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [companyId, val.value, lab.label]
    );

    const row = await fetchWithCompany(insert.rows[0].id);
    return sendSuccess(res, 201, 'Dependant relationship type created successfully.', {
      relationship_type: mapRow(row || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A relationship type with this value already exists for this company.');
    }
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createDependantRelationshipType error:', error);
    return sendError(res, 500, 'Something went wrong while creating relationship type.');
  }
}

/** GET /api/v1/dependant-relationship-types?company_id= */
async function getDependantRelationshipTypes(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM dependant_relationship_types WHERE company_id = $1`,
      [companyId]
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `${companyJoinSelect}
       WHERE drt.company_id = $1
       ORDER BY drt.label ASC`,
          [companyId]
        )
      : await pool.query(
          `${companyJoinSelect}
       WHERE drt.company_id = $1
       ORDER BY drt.label ASC
       LIMIT $2 OFFSET $3`,
          [companyId, listPagination.pagination.limit, listPagination.pagination.offset]
        );

    const customTypes = result.rows.map(mapRow);
    const defaultValues = new Set(DEFAULT_RELATIONSHIP_TYPES.map((d) => d.value));
    const mergedDefaults = DEFAULT_RELATIONSHIP_TYPES.filter(
      (d) => !customTypes.some((c) => c.value === d.value)
    );
    const relationships = [
      ...mergedDefaults.map((d) => ({ ...d, id: null, company_id: companyId, is_default: true })),
      ...customTypes.map((r) => ({ ...r, is_default: false })),
      { value: 'other', label: 'Other', id: null, company_id: companyId, is_default: true },
    ];

    return sendSuccess(res, 200, 'Dependant relationship types fetched successfully.', {
      relationship_types: customTypes,
      relationships,
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getDependantRelationshipTypes error:', error);
    return sendError(res, 500, 'Something went wrong while fetching relationship types.');
  }
}

/** GET /api/v1/dependant-relationship-types/:id?company_id= */
async function getDependantRelationshipTypeById(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  if (!typeId) return sendError(res, 400, 'Relationship type id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(`${companyJoinSelect} WHERE drt.id = $1 AND drt.company_id = $2`, [
      typeId,
      companyId,
    ]);

    if (result.rowCount === 0) return sendError(res, 404, 'Relationship type not found.');
    return sendSuccess(res, 200, 'Relationship type fetched successfully.', {
      relationship_type: mapRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getDependantRelationshipTypeById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching relationship type.');
  }
}

/** PATCH /api/v1/dependant-relationship-types/:id */
async function updateDependantRelationshipType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!typeId) return sendError(res, 400, 'Relationship type id must be a positive integer.');
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
    values.push(typeId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await pool.query(
      `UPDATE dependant_relationship_types
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Relationship type not found.');

    const row = await fetchWithCompany(updated.rows[0].id);
    return sendSuccess(res, 200, 'Relationship type updated successfully.', {
      relationship_type: mapRow(row || updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'A relationship type with this value already exists for this company.');
    }
    console.error('updateDependantRelationshipType error:', error);
    return sendError(res, 500, 'Something went wrong while updating relationship type.');
  }
}

/** DELETE /api/v1/dependant-relationship-types/:id?company_id= */
async function deleteDependantRelationshipType(req, res) {
  const typeId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!typeId) return sendError(res, 400, 'Relationship type id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM dependant_relationship_types WHERE id = $1 AND company_id = $2 RETURNING *`,
      [typeId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Relationship type not found.');

    return sendSuccess(res, 200, 'Relationship type deleted successfully.', {
      relationship_type: mapRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteDependantRelationshipType error:', error);
    return sendError(res, 500, 'Something went wrong while deleting relationship type.');
  }
}

module.exports = {
  DEFAULT_RELATIONSHIP_TYPES,
  slugifyRelationshipLabel,
  relationshipValueExistsForCompany,
  upsertRelationshipType,
  createDependantRelationshipType,
  getDependantRelationshipTypes,
  getDependantRelationshipTypeById,
  updateDependantRelationshipType,
  deleteDependantRelationshipType,
};
