const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { requireE164 } = require('../utils/phoneValidation');
const {
  DEFAULT_RELATIONSHIP_TYPES,
  slugifyRelationshipLabel,
  relationshipValueExistsForCompany,
  upsertRelationshipType,
} = require('./dependantRelationshipTypes.controller');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeFullName(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return { error: 'full_name is required.' };
  if (s.length < 2) return { error: 'full_name must be at least 2 characters.' };
  if (s.length > 120) return { error: 'full_name must be at most 120 characters.' };
  if (!/^[A-Za-z]+(?:[ '\-][A-Za-z]+)*$/.test(s)) {
    return {
      error:
        "full_name can only contain letters, spaces, hyphens, and apostrophes.",
    };
  }
  return { full_name: s };
}

function parseRequiredPhoneNo(value) {
  const result = requireE164(value, { fieldName: 'Phone no' });
  if (result.error) {
    return { ok: false, message: result.error };
  }
  return { ok: true, phone_no: result.e164 };
}

/** BIGINT/BIGSERIAL from node-pg may be string, number, or bigint — always JSON-safe for `id`. */
function serializeRowId(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'bigint') {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val.toString();
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : String(val);
}

function mapDependantRow(row) {
  const id = serializeRowId(row?.id);
  const company_id = serializeRowId(row?.company_id);
  return {
    id,
    dependant_id: id,
    company_id,
    relationship: row.relationship,
    relationship_label: row.relationship_label ?? null,
    full_name: row.full_name,
    phone_no: row.phone_no != null && String(row.phone_no).trim() !== '' ? String(row.phone_no).trim() : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function buildRelationshipOptionsList(companyId) {
  const custom = await pool.query(
    `SELECT value, label FROM dependant_relationship_types
     WHERE company_id = $1
     ORDER BY label ASC`,
    [companyId]
  );
  const customTypes = custom.rows.map((r) => ({ value: r.value, label: r.label }));
  const seen = new Set(customTypes.map((r) => r.value));
  const merged = [];
  for (const d of DEFAULT_RELATIONSHIP_TYPES) {
    if (!seen.has(d.value)) merged.push({ ...d });
  }
  merged.push(...customTypes);
  merged.push({ value: 'other', label: 'Other' });
  return merged;
}

/**
 * Resolve stored relationship slug for employee_dependants.
 * @returns {Promise<{ ok: true, value: string, label?: string } | { ok: false, message: string }>}
 */
async function resolveRelationshipForCreate(db, companyId, body) {
  const rawRel = body.relationship !== undefined && body.relationship !== null ? String(body.relationship).trim().toLowerCase() : '';
  if (!rawRel) {
    return { ok: false, message: 'relationship is required.' };
  }

  if (rawRel === 'other') {
    const otherRaw = body.relationship_other ?? body.relationship_label ?? body.custom_relationship;
    const slugged = slugifyRelationshipLabel(otherRaw);
    if (slugged.error) {
      return { ok: false, message: 'When relationship is "other", provide relationship_other with your custom type.' };
    }
    await upsertRelationshipType(db, companyId, slugged.value, slugged.label);
    return { ok: true, value: slugged.value, label: slugged.label };
  }

  const exists = await relationshipValueExistsForCompany(companyId, rawRel);
  if (!exists) {
    return {
      ok: false,
      message:
        'relationship is not valid for this company. Add it under dependant relationship types or choose Other.',
    };
  }

  const label =
    DEFAULT_RELATIONSHIP_TYPES.find((d) => d.value === rawRel)?.label ||
    (
      await db.query(
        `SELECT label FROM dependant_relationship_types WHERE company_id = $1 AND value = $2`,
        [companyId, rawRel]
      )
    ).rows[0]?.label ||
    rawRel;

  return { ok: true, value: rawRel, label };
}

/** GET /api/v1/dependants/relationship-options?company_id= — public */
async function getRelationshipOptions(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const relationships = await buildRelationshipOptionsList(companyId);
    return sendSuccess(res, 200, 'Relationship options fetched successfully.', {
      relationships,
    });
  } catch (error) {
    console.error('getRelationshipOptions error:', error);
    return sendError(res, 500, 'Something went wrong while fetching relationship options.');
  }
}

/**
 * Core insert shared by POST /dependants and the onboarding profile update
 * (dependants[] entries with no id yet — created inline, same validation).
 * Caller owns the transaction (`db` can be `pool` or a connected `client`).
 * @returns {Promise<{ ok: true, dependant: object } | { ok: false, message: string }>}
 */
async function createDependantRecord(db, companyId, body) {
  const name = normalizeFullName(body.full_name);
  if (name.error) return { ok: false, message: name.error };

  const phoneParsed = parseRequiredPhoneNo(body.phone_no);
  if (!phoneParsed.ok) return { ok: false, message: phoneParsed.message };

  const relResolved = await resolveRelationshipForCreate(db, companyId, body);
  if (!relResolved.ok) return { ok: false, message: relResolved.message };

  const insert = await db.query(
    `INSERT INTO employee_dependants (
       company_id, relationship, relationship_label, full_name, phone_no, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING *`,
    [companyId, relResolved.value, relResolved.label ?? null, name.full_name, phoneParsed.phone_no]
  );

  return { ok: true, dependant: mapDependantRow(insert.rows[0]) };
}

/** POST /api/v1/dependants — public */
async function createDependant(req, res) {
  const b = req.body || {};
  const companyId = parsePositiveInt(b.company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await createDependantRecord(client, companyId, b);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, result.message);
    }

    await client.query('COMMIT');
    return sendSuccess(res, 201, 'Dependant created successfully.', {
      dependant: result.dependant,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23503') {
      return sendError(res, 400, 'company_id does not reference a valid company.');
    }
    console.error('createDependant error:', error);
    return sendError(res, 500, 'Something went wrong while creating dependant.');
  } finally {
    client.release();
  }
}

/** GET /api/v1/dependants?company_id= — public */
async function getDependants(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM employee_dependants WHERE company_id = $1`,
      [companyId]
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `SELECT id, company_id, relationship, relationship_label, full_name, phone_no, created_at, updated_at
           FROM employee_dependants
           WHERE company_id = $1
           ORDER BY id DESC`,
          [companyId]
        )
      : await pool.query(
          `SELECT id, company_id, relationship, relationship_label, full_name, phone_no, created_at, updated_at
           FROM employee_dependants
           WHERE company_id = $1
           ORDER BY id DESC
           LIMIT $2 OFFSET $3`,
          [companyId, listPagination.pagination.limit, listPagination.pagination.offset]
        );

    return sendSuccess(res, 200, 'Dependants fetched successfully.', {
      dependants: result.rows.map(mapDependantRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getDependants error:', error);
    return sendError(res, 500, 'Something went wrong while fetching dependants.');
  }
}

/** GET /api/v1/dependants/:id?company_id= — public; company_id required */
async function getDependantById(req, res) {
  const dependantId = parsePositiveInt(req.params.id);
  if (!dependantId) return sendError(res, 400, 'Dependant id must be a positive integer.');

  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(
      `SELECT id, company_id, relationship, relationship_label, full_name, phone_no, created_at, updated_at
       FROM employee_dependants WHERE id = $1 AND company_id = $2`,
      [dependantId, companyId]
    );

    if (result.rowCount === 0) return sendError(res, 404, 'Dependant not found.');
    return sendSuccess(res, 200, 'Dependant fetched successfully.', {
      dependant: mapDependantRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getDependantById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching dependant.');
  }
}

/** PATCH /api/v1/dependants/:id — public */
async function updateDependant(req, res) {
  const dependantId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = parsePositiveInt(body.company_id);

  if (!dependantId) return sendError(res, 400, 'Dependant id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set([
    'company_id',
    'relationship',
    'relationship_other',
    'relationship_label',
    'custom_relationship',
    'full_name',
    'phone_no',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return sendError(res, 400, `Unknown field "${key}".`);
    }
  }

  const hasRel = Object.prototype.hasOwnProperty.call(body, 'relationship');
  const hasName = Object.prototype.hasOwnProperty.call(body, 'full_name');
  const hasPhone = Object.prototype.hasOwnProperty.call(body, 'phone_no');
  if (!hasRel && !hasName && !hasPhone) {
    return sendError(res, 400, 'Provide relationship, full_name, and/or phone_no to update.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let nextRel;
    let nextRelLabel;
    if (hasRel) {
      const relResolved = await resolveRelationshipForCreate(client, companyId, body);
      if (!relResolved.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, relResolved.message);
      }
      nextRel = relResolved.value;
      nextRelLabel = relResolved.label ?? null;
    }

    let nextName;
    if (hasName) {
      const n = normalizeFullName(body.full_name);
      if (n.error) {
        await client.query('ROLLBACK');
        return sendError(res, 400, n.error);
      }
      nextName = n.full_name;
    }
    let nextPhone;
    if (hasPhone) {
      const p = parseRequiredPhoneNo(body.phone_no);
      if (!p.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, p.message);
      }
      nextPhone = p.phone_no;
    }

    const updates = [];
    const values = [];
    let idx = 1;
    if (hasRel) {
      updates.push(`relationship = $${idx++}`);
      values.push(nextRel);
      updates.push(`relationship_label = $${idx++}`);
      values.push(nextRelLabel);
    }
    if (hasName) {
      updates.push(`full_name = $${idx++}`);
      values.push(nextName);
    }
    if (hasPhone) {
      updates.push(`phone_no = $${idx++}`);
      values.push(nextPhone);
    }

    values.push(dependantId, companyId);
    const idPos = idx++;
    const companyPos = idx++;

    const updated = await client.query(
      `UPDATE employee_dependants
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idPos} AND company_id = $${companyPos}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Dependant not found.');
    }

    await client.query('COMMIT');
    return sendSuccess(res, 200, 'Dependant updated successfully.', {
      dependant: mapDependantRow(updated.rows[0]),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('updateDependant error:', error);
    return sendError(res, 500, 'Something went wrong while updating dependant.');
  } finally {
    client.release();
  }
}

/** DELETE /api/v1/dependants/:id?company_id= — public */
async function deleteDependant(req, res) {
  const dependantId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!dependantId) return sendError(res, 400, 'Dependant id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const deleted = await pool.query(
      `DELETE FROM employee_dependants WHERE id = $1 AND company_id = $2 RETURNING *`,
      [dependantId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Dependant not found.');

    return sendSuccess(res, 200, 'Dependant deleted successfully.', {
      dependant: mapDependantRow(deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteDependant error:', error);
    return sendError(res, 500, 'Something went wrong while deleting dependant.');
  }
}

module.exports = {
  buildRelationshipOptionsList,
  getRelationshipOptions,
  createDependant,
  createDependantRecord,
  getDependants,
  getDependantById,
  updateDependant,
  deleteDependant,
};
