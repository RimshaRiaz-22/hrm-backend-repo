const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapDesignationRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    company_name: row.company_name ?? null,
    company_admin_email: row.company_admin_email ?? null,
    name: row.name,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

async function getAuthenticatedCompanyAdmin(req) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [req.authUser.userId, req.authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const admin = result.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active) {
    return { error: [403, 'Your account is inactive. Please contact support.'] };
  }
  return { admin };
}

async function canAdminAccessCompany(admin, companyId) {
  const result = await pool.query(
    `SELECT id
     FROM companies
     WHERE id = $1
       AND is_active = true
       AND (super_admin_id = $2 OR ($3::bigint IS NOT NULL AND id = $3))`,
    [companyId, admin.id, admin.company_id ?? null]
  );
  return result.rowCount > 0;
}

/** POST /api/v1/designations */
async function createDesignation(req, res) {
  const { company_id, name } = req.body || {};
  const companyId = parsePositiveInt(company_id);
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const designationName = String(name || '').trim();
  if (!designationName) return sendError(res, 400, 'name is required.');
  if (designationName.length < 2) return sendError(res, 400, 'name must be at least 2 characters.');
  if (designationName.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only manage designations for your own company.');

    const nowUtc = utcNowForPgTimestamp();
    const insert = await pool.query(
      `INSERT INTO designations (company_id, name, created_at, updated_at)
       VALUES ($1, $2, $3::timestamp, $3::timestamp)
       RETURNING *`,
      [companyId, designationName, nowUtc]
    );
    const withCompany = await pool.query(
      `SELECT d.*,
              c.name AS company_name,
              COALESCE(
                (
                  SELECT u.email
                  FROM users u
                  WHERE u.company_id = c.id
                    AND u.role = $1
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
       FROM designations d
       JOIN companies c ON c.id = d.company_id
       WHERE d.id = $2`,
      [USER_ROLES.COMPANY_ADMIN, insert.rows[0].id]
    );

    return sendSuccess(res, 201, 'Designation created successfully.', {
      designation: mapDesignationRow(withCompany.rows[0] || insert.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'Designation name already exists for this company.');
    }
    console.error('createDesignation error:', error);
    return sendError(res, 500, 'Something went wrong while creating designation.');
  }
}

/** GET /api/v1/designations?company_id= */
async function getDesignations(req, res) {
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  const search = String(req.query?.search || '').trim();
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) {
    return sendError(res, 400, listPagination.error);
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only view designations for your own company.');

    const countValues = [companyId];
    let countSearchClause = '';
    if (search) {
      countValues.push(`%${search}%`);
      countSearchClause = 'AND (d.name ILIKE $2 OR d.id::text ILIKE $2)';
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM designations d
       WHERE d.company_id = $1 ${countSearchClause}`,
      countValues
    );

    const listValues = [USER_ROLES.COMPANY_ADMIN, companyId];
    let listSearchClause = '';
    if (search) {
      listValues.push(`%${search}%`);
      listSearchClause = 'AND (d.name ILIKE $3 OR d.id::text ILIKE $3)';
    }

    const designationSelect = `SELECT d.*,
                  c.name AS company_name,
                  COALESCE(
                    (
                      SELECT u.email
                      FROM users u
                      WHERE u.company_id = c.id
                        AND u.role = $1
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
           FROM designations d
           JOIN companies c ON c.id = d.company_id`;

    const result = listPagination.noPagination
      ? await pool.query(
          `${designationSelect}
           WHERE d.company_id = $2 ${listSearchClause}
           ORDER BY d.name ASC`,
          listValues
        )
      : await pool.query(
          `${designationSelect}
           WHERE d.company_id = $2 ${listSearchClause}
           ORDER BY d.name ASC
           LIMIT $${listValues.length + 1} OFFSET $${listValues.length + 2}`,
          [
            ...listValues,
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    return sendSuccess(res, 200, 'Designations fetched successfully.', {
      designations: result.rows.map(mapDesignationRow),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getDesignations error:', error);
    return sendError(res, 500, 'Something went wrong while fetching designations.');
  }
}

/** GET /api/v1/designations/:id?company_id= */
async function getDesignationById(req, res) {
  const designationId = parsePositiveInt(req.params.id);
  if (!designationId) return sendError(res, 400, 'Designation id must be a positive integer.');

  const companyId = req.query?.company_id ? parsePositiveInt(req.query.company_id) : null;
  if (req.query?.company_id && !companyId) {
    return sendError(res, 400, 'company_id query parameter must be a positive integer when provided.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    let result;
    if (companyId) {
      const allowed = await canAdminAccessCompany(auth.admin, companyId);
      if (!allowed) return sendError(res, 403, 'You can only view designations for your own company.');
      result = await pool.query(
        `SELECT d.*,
                c.name AS company_name,
                COALESCE(
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
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
         FROM designations d
         JOIN companies c ON c.id = d.company_id
         WHERE d.id = $2 AND d.company_id = $3`,
        [USER_ROLES.COMPANY_ADMIN, designationId, companyId]
      );
    } else {
      result = await pool.query(
        `SELECT d.*,
                c.name AS company_name,
                COALESCE(
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
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
         FROM designations d
         JOIN companies c ON c.id = d.company_id
         WHERE d.id = $2
           AND d.company_id IN (
             SELECT c2.id
             FROM companies c2
             WHERE c2.is_active = true
               AND (c2.super_admin_id = $3 OR ($4::bigint IS NOT NULL AND c2.id = $4))
           )`,
        [USER_ROLES.COMPANY_ADMIN, designationId, auth.admin.id, auth.admin.company_id ?? null]
      );
    }

    if (result.rowCount === 0) return sendError(res, 404, 'Designation not found.');
    return sendSuccess(res, 200, 'Designation fetched successfully.', {
      designation: mapDesignationRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getDesignationById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching designation.');
  }
}

/** PATCH /api/v1/designations/:id */
async function updateDesignation(req, res) {
  const designationId = parsePositiveInt(req.params.id);
  const { company_id, name } = req.body || {};
  const companyId = parsePositiveInt(company_id);

  if (!designationId) return sendError(res, 400, 'Designation id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');
  const designationName = String(name || '').trim();
  if (!designationName) return sendError(res, 400, 'name is required.');
  if (designationName.length < 2) return sendError(res, 400, 'name must be at least 2 characters.');
  if (designationName.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only update designations for your own company.');

    const nowUtc = utcNowForPgTimestamp();
    const updated = await pool.query(
      `UPDATE designations
       SET name = $1, updated_at = $2::timestamp
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [designationName, nowUtc, designationId, companyId]
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Designation not found.');

    const withCompany = await pool.query(
      `SELECT d.*,
              c.name AS company_name,
              COALESCE(
                (
                  SELECT u.email
                  FROM users u
                  WHERE u.company_id = c.id
                    AND u.role = $1
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
       FROM designations d
       JOIN companies c ON c.id = d.company_id
       WHERE d.id = $2`,
      [USER_ROLES.COMPANY_ADMIN, updated.rows[0].id]
    );
    return sendSuccess(res, 200, 'Designation updated successfully.', {
      designation: mapDesignationRow(withCompany.rows[0] || updated.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return sendError(res, 409, 'Designation name already exists for this company.');
    }
    console.error('updateDesignation error:', error);
    return sendError(res, 500, 'Something went wrong while updating designation.');
  }
}

/** DELETE /api/v1/designations/:id?company_id= */
async function deleteDesignation(req, res) {
  const designationId = parsePositiveInt(req.params.id);
  const companyId = parsePositiveInt(req.query?.company_id);
  if (!designationId) return sendError(res, 400, 'Designation id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const allowed = await canAdminAccessCompany(auth.admin, companyId);
    if (!allowed) return sendError(res, 403, 'You can only delete designations for your own company.');

    const deleted = await pool.query(
      `DELETE FROM designations
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [designationId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Designation not found.');

    const withCompany = await pool.query(
      `SELECT d.*,
              c.name AS company_name,
              (
                SELECT u.email
                FROM users u
                WHERE u.company_id = c.id
                  AND u.role = $1
                ORDER BY u.id ASC
                LIMIT 1
              ) AS company_admin_email
       FROM designations d
       JOIN companies c ON c.id = d.company_id
       WHERE d.id = $2`,
      [USER_ROLES.COMPANY_ADMIN, deleted.rows[0].id]
    );
    return sendSuccess(res, 200, 'Designation deleted successfully.', {
      designation: mapDesignationRow(withCompany.rows[0] || deleted.rows[0]),
    });
  } catch (error) {
    console.error('deleteDesignation error:', error);
    return sendError(res, 500, 'Something went wrong while deleting designation.');
  }
}

module.exports = {
  createDesignation,
  getDesignations,
  getDesignationById,
  updateDesignation,
  deleteDesignation,
};

