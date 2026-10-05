const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { utcNowForPgTimestamp } = require('../utils/dateTime');
const {
  normalizePermissionMatrix,
  matrixToDbRows,
  emptyPermissionsMatrix,
  invalidateRoleCache,
  applyMainDashboardSync,
} = require('./accessControl.service');
const { ACCESS_ROLE_TEMPLATES, isPermissionsLockedRole } = require('../constants/accessRoleTemplates');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeName(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'name is required.' };
  if (s.length > 120) return { error: 'name must be at most 120 characters.' };
  return { value: s };
}

async function loadActiveUser(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, access_role_id, is_active
     FROM users WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.', status: 401 };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.', status: 403 };
  return { user };
}

async function resolveCompanyIdForUser(user, requestedCompanyId) {
  if (String(user.role).trim().toLowerCase() === USER_ROLES.SUPER_ADMIN) {
    return requestedCompanyId || user.company_id || null;
  }
  if (!user.company_id) {
    return { error: 'Your account must be linked to a company.', status: 403 };
  }
  if (requestedCompanyId && Number(requestedCompanyId) !== Number(user.company_id)) {
    return { error: 'company_id does not match your company.', status: 403 };
  }
  return Number(user.company_id);
}

function mapRoleRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    description: row.description ?? null,
    is_system_template: row.is_system_template === true,
    is_permissions_locked: isPermissionsLockedRole(row),
    users_count: row.users_count != null ? Number(row.users_count) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchRolePermissionsMatrix(roleId) {
  const result = await pool.query(
    `SELECT module_key, can_view, can_add, can_edit, can_delete
     FROM access_role_permissions WHERE access_role_id = $1`,
    [roleId]
  );
  const matrix = emptyPermissionsMatrix();
  for (const row of result.rows) {
    matrix[row.module_key] = {
      view: row.can_view === true,
      add: row.can_add === true,
      edit: row.can_edit === true,
      delete: row.can_delete === true,
    };
  }
  return applyMainDashboardSync(matrix);
}

async function listAccessRoles(auth, query) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(query?.company_id));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: listPagination.error, status: 400 };

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM access_roles ar
     WHERE ar.company_id = $1
       AND ($2::text = '' OR ar.name ILIKE $2 OR COALESCE(ar.description, '') ILIKE $2)`,
    [companyId, search]
  );

  const listSql = `
    SELECT ar.*,
           (SELECT COUNT(*)::int FROM users u WHERE u.access_role_id = ar.id) AS users_count
    FROM access_roles ar
    WHERE ar.company_id = $1
      AND ($2::text = '' OR ar.name ILIKE $2 OR COALESCE(ar.description, '') ILIKE $2)
    ORDER BY ar.is_system_template DESC, ar.name ASC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, [companyId, search])
    : await pool.query(`${listSql} LIMIT $3 OFFSET $4`, [
        companyId,
        search,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    access_roles: result.rows.map(mapRoleRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getAccessRoleById(auth, roleId, companyIdRaw) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(companyIdRaw));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const result = await pool.query(
    `SELECT ar.*,
            (SELECT COUNT(*)::int FROM users u WHERE u.access_role_id = ar.id) AS users_count
     FROM access_roles ar
     WHERE ar.id = $1 AND ar.company_id = $2`,
    [roleId, companyId]
  );
  if (result.rowCount === 0) return { error: 'Access role not found.', status: 404 };

  const permissions = await fetchRolePermissionsMatrix(roleId);
  return { access_role: mapRoleRow(result.rows[0]), permissions };
}

async function createAccessRole(auth, body) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(body?.company_id));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const name = normalizeName(body?.name);
  if (name.error) return { error: name.error, status: 400 };

  const description =
    body?.description !== undefined && body?.description !== null
      ? String(body.description).trim() || null
      : null;

  const nowUtc = utcNowForPgTimestamp();
  try {
    const inserted = await pool.query(
      `INSERT INTO access_roles (company_id, name, description, is_system_template, created_at, updated_at)
       VALUES ($1, $2, $3, FALSE, $4::timestamp, $4::timestamp)
       RETURNING *`,
      [companyId, name.value, description, nowUtc]
    );
    const role = mapRoleRow(inserted.rows[0]);
    return { access_role: role, permissions: emptyPermissionsMatrix() };
  } catch (error) {
    if (error?.code === '23505') {
      return { error: 'An access role with this name already exists for this company.', status: 409 };
    }
    throw error;
  }
}

async function updateAccessRole(auth, roleId, body) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(body?.company_id));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const hasName = Object.prototype.hasOwnProperty.call(body || {}, 'name');
  const hasDescription = Object.prototype.hasOwnProperty.call(body || {}, 'description');
  if (!hasName && !hasDescription) {
    return { error: 'Provide name and/or description to update.', status: 400 };
  }

  let nextName;
  if (hasName) {
    const n = normalizeName(body.name);
    if (n.error) return { error: n.error, status: 400 };
    nextName = n.value;
  }

  const updates = [];
  const values = [];
  let idx = 1;
  if (hasName) {
    updates.push(`name = $${idx++}`);
    values.push(nextName);
  }
  if (hasDescription) {
    updates.push(`description = $${idx++}`);
    values.push(body.description != null ? String(body.description).trim() || null : null);
  }
  const nowUtc = utcNowForPgTimestamp();
  updates.push(`updated_at = $${idx++}::timestamp`);
  values.push(nowUtc);
  values.push(roleId, companyId);

  try {
    const updated = await pool.query(
      `UPDATE access_roles SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      values
    );
    if (updated.rowCount === 0) return { error: 'Access role not found.', status: 404 };
    await invalidateRoleCache(roleId);
    const permissions = await fetchRolePermissionsMatrix(roleId);
    return { access_role: mapRoleRow(updated.rows[0]), permissions };
  } catch (error) {
    if (error?.code === '23505') {
      return { error: 'An access role with this name already exists for this company.', status: 409 };
    }
    throw error;
  }
}

async function saveAccessRolePermissions(auth, roleId, body) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(body?.company_id));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const roleCheck = await pool.query(
    `SELECT id, name, is_system_template FROM access_roles WHERE id = $1 AND company_id = $2`,
    [roleId, companyId]
  );
  if (roleCheck.rowCount === 0) return { error: 'Access role not found.', status: 404 };
  if (isPermissionsLockedRole(roleCheck.rows[0])) {
    return { error: 'This role\'s permissions are fixed and cannot be edited.', status: 400 };
  }

  const matrix = applyMainDashboardSync(normalizePermissionMatrix(body?.permissions || body));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nowUtc = utcNowForPgTimestamp();
    for (const row of matrixToDbRows(matrix)) {
      await client.query(
        `INSERT INTO access_role_permissions
           (access_role_id, module_key, can_view, can_add, can_edit, can_delete, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp)
         ON CONFLICT (access_role_id, module_key) DO UPDATE SET
           can_view = EXCLUDED.can_view,
           can_add = EXCLUDED.can_add,
           can_edit = EXCLUDED.can_edit,
           can_delete = EXCLUDED.can_delete,
           updated_at = EXCLUDED.updated_at`,
        [roleId, row.module_key, row.can_view, row.can_add, row.can_edit, row.can_delete, nowUtc]
      );
    }
    await client.query(
      `UPDATE access_roles SET updated_at = $2::timestamp WHERE id = $1`,
      [roleId, nowUtc]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await invalidateRoleCache(roleId);
  const access_role = await pool.query(`SELECT * FROM access_roles WHERE id = $1`, [roleId]);
  return {
    access_role: mapRoleRow(access_role.rows[0]),
    permissions: matrix,
  };
}

async function deleteAccessRole(auth, roleId, companyIdRaw) {
  const loaded = await loadActiveUser(auth);
  if (loaded.error) return loaded;

  const companyId = await resolveCompanyIdForUser(loaded.user, parsePositiveInt(companyIdRaw));
  if (companyId?.error) return companyId;
  if (!companyId) return { error: 'company_id is required.', status: 400 };

  const existing = await pool.query(
    `SELECT ar.*,
            (SELECT COUNT(*)::int FROM users u WHERE u.access_role_id = ar.id) AS users_count
     FROM access_roles ar
     WHERE ar.id = $1 AND ar.company_id = $2`,
    [roleId, companyId]
  );
  if (existing.rowCount === 0) return { error: 'Access role not found.', status: 404 };

  const row = existing.rows[0];
  if (row.is_system_template) {
    return { error: 'System template roles cannot be deleted.', status: 400 };
  }
  if (Number(row.users_count) > 0) {
    return { error: 'Cannot delete a role that is assigned to users.', status: 400 };
  }

  await pool.query(`DELETE FROM access_roles WHERE id = $1 AND company_id = $2`, [roleId, companyId]);
  await invalidateRoleCache(roleId);
  return { access_role: mapRoleRow(row) };
}

async function seedCompanyDefaultRoles(companyId, client = pool) {
  const roleIdByName = {};
  for (const template of ACCESS_ROLE_TEMPLATES) {
    const inserted = await client.query(
      `INSERT INTO access_roles (company_id, name, description, is_system_template, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (company_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         is_system_template = EXCLUDED.is_system_template,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyId, template.name, template.description, template.is_system_template]
    );
    const roleId = inserted.rows[0].id;
    roleIdByName[template.name] = roleId;
    for (const row of matrixToDbRows(template.matrix)) {
      await client.query(
        `INSERT INTO access_role_permissions
           (access_role_id, module_key, can_view, can_add, can_edit, can_delete, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (access_role_id, module_key) DO UPDATE SET
           can_view = EXCLUDED.can_view,
           can_add = EXCLUDED.can_add,
           can_edit = EXCLUDED.can_edit,
           can_delete = EXCLUDED.can_delete,
           updated_at = CURRENT_TIMESTAMP`,
        [roleId, row.module_key, row.can_view, row.can_add, row.can_edit, row.can_delete]
      );
    }
  }
  return roleIdByName;
}

module.exports = {
  listAccessRoles,
  getAccessRoleById,
  createAccessRole,
  updateAccessRole,
  saveAccessRolePermissions,
  deleteAccessRole,
  seedCompanyDefaultRoles,
};
