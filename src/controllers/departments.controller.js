const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const {
  listCacheKey,
  detailCacheKey,
  summaryCacheKey,
  getCachedJson,
  setCachedJson,
  invalidateCompanyDepartments,
} = require('../services/departmentsCache.service');
const lineManagerService = require('../services/lineManager.service');

const DEPARTMENT_EMPLOYEES_COUNT_SQL = `(
  SELECT COUNT(*)::int
  FROM employee_job_details ejd
  WHERE ejd.department_id = d.id
    AND ejd.company_id = d.company_id
) AS employees_count`;

const DEPARTMENT_SUB_DEPTS_COUNT_SQL = `(
  SELECT COUNT(*)::int
  FROM departments sd
  WHERE sd.parent_dept_id = d.id
) AS sub_departments_count`;

function parsePositiveInt(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Resolve company id from query, body, or JWT (first valid positive integer). */
function resolveCompanyId(req) {
  const candidates = [
    req.query?.company_id,
    req.query?.companyId,
    req.body?.company_id,
    req.body?.companyId,
    req.authUser?.companyId,
    req.authUser?.company_id,
  ];
  for (const candidate of candidates) {
    const parsed = parsePositiveInt(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function parseBooleanFlag(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return { value: defaultValue };
  if (value === true || value === 'true' || value === 1 || value === '1') return { value: true };
  if (value === false || value === 'false' || value === 0 || value === '0') return { value: false };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'active') return { value: true };
    if (normalized === 'inactive') return { value: false };
  }
  return { error: 'is_active must be true or false.' };
}

function parseOptionalText(value, maxLen) {
  if (value === undefined || value === null) return { value: null };
  const text = String(value).trim();
  if (!text) return { value: null };
  if (text.length > maxLen) return { error: `must be at most ${maxLen} characters.` };
  return { value: text };
}

function mapDepartmentRow(row, lineManagersPayload = null) {
  const base = {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    department_code: row.department_code ?? null,
    branch_or_location: row.branch_or_location ?? null,
    description: row.description ?? null,
    status: row.is_active === false ? 'inactive' : 'active',
    employees_count:
      row.employees_count !== undefined && row.employees_count !== null
        ? Number(row.employees_count)
        : 0,
    sub_departments_count:
      row.sub_departments_count !== undefined && row.sub_departments_count !== null
        ? Number(row.sub_departments_count)
        : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (lineManagersPayload) {
    base.department_head_id = lineManagersPayload.department_head_id;
    base.department_head = lineManagersPayload.department_head;
    base.primary_manager_id = lineManagersPayload.primary_manager_id;
    base.primary_manager = lineManagersPayload.primary_manager;
    base.additional_manager_ids = lineManagersPayload.additional_manager_ids;
    base.additional_managers = lineManagersPayload.additional_managers;
    base.line_manager_ids = lineManagersPayload.line_manager_ids;
    base.line_managers = lineManagersPayload.line_managers;
  } else {
    base.department_head_id = null;
    base.department_head = null;
    base.primary_manager_id = null;
    base.primary_manager = null;
    base.additional_manager_ids = [];
    base.additional_managers = [];
    base.line_manager_ids = [];
    base.line_managers = [];
  }
  return base;
}

async function attachLineManagersToDepartments(db, companyId, departmentRows) {
  const deptIds = departmentRows.map((r) => Number(r.id));
  const byDept = await lineManagerService.loadLineManagersByDepartmentIds(db, companyId, deptIds);
  return departmentRows.map((row) => {
    const payload = byDept.get(Number(row.id)) || lineManagerService.buildDepartmentManagersPayload();
    return mapDepartmentRow(row, payload);
  });
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

function resolveLinkedCompanyId(adminCompanyId, tokenCompanyId) {
  return parsePositiveInt(adminCompanyId) || parsePositiveInt(tokenCompanyId) || null;
}

async function canAdminAccessCompany(admin, companyId, tokenCompanyId) {
  const companyResult = await pool.query(
    `SELECT id, is_active, super_admin_id
     FROM companies
     WHERE id = $1`,
    [companyId]
  );
  if (companyResult.rowCount === 0) {
    return { ok: false, message: 'Selected company was not found.' };
  }

  const company = companyResult.rows[0];
  if (company.is_active !== true) {
    return { ok: false, message: 'Selected company is inactive.' };
  }

  const adminId = parsePositiveInt(admin.id);
  const linkedCompanyId = resolveLinkedCompanyId(admin.company_id, tokenCompanyId);
  const ownerId = parsePositiveInt(company.super_admin_id);
  const companyRowId = parsePositiveInt(company.id);

  if ((ownerId && adminId && ownerId === adminId) || (linkedCompanyId && companyRowId === linkedCompanyId)) {
    return { ok: true };
  }

  return { ok: false, message: 'You can only manage departments for your own company.' };
}

function isDepartmentCreatePayload(body) {
  const b = body || {};
  if (String(b.name || '').trim()) return true;
  return ['department_code', 'branch_or_location', 'description', 'is_active', 'status', 'line_manager_ids', 'department_head_id', 'primary_manager_id', 'additional_manager_ids'].some(
    (key) => Object.prototype.hasOwnProperty.call(b, key)
  );
}

/** POST /api/v1/departments — create; list-only POST (no name) delegates to GET list */
async function createDepartment(req, res) {
  const body = req.body || {};
  const { name, department_code, branch_or_location, description } = body;

  if (!isDepartmentCreatePayload(body)) {
    return getDepartments(req, res);
  }

  const companyId = resolveCompanyId(req);
  if (!companyId) {
    return sendError(res, 400, 'company_id is required and must be a positive integer.');
  }
  const deptName = String(name || '').trim();
  if (!deptName) {
    return sendError(
      res,
      400,
      'name is required to create a department. To list departments, use GET /api/v1/departments?company_id=<id>.'
    );
  }
  if (deptName.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');

  const deptCodeParsed = parseOptionalText(department_code, 50);
  if (deptCodeParsed.error) {
    return sendError(res, 400, `department_code ${deptCodeParsed.error}`);
  }
  const branchParsed = parseOptionalText(branch_or_location, 120);
  if (branchParsed.error) {
    return sendError(res, 400, `branch_or_location ${branchParsed.error}`);
  }
  const descParsed = parseOptionalText(description, 2000);
  if (descParsed.error) {
    return sendError(res, 400, `description ${descParsed.error}`);
  }

  const isActiveSource =
    body.is_active !== undefined ? body.is_active : body.status !== undefined ? body.status : undefined;
  const isActiveParsed = parseBooleanFlag(isActiveSource, true);
  if (isActiveParsed.error) return sendError(res, 400, isActiveParsed.error);

  const managersParsed = lineManagerService.parseDepartmentManagers(body);
  if (managersParsed.error) return sendError(res, 400, managersParsed.error);
  const departmentHeadId = managersParsed.omitted ? null : managersParsed.departmentHeadId;

  const client = await pool.connect();
  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    if (departmentHeadId) {
      const empCheck = await lineManagerService.assertEmployeesInCompany(client, companyId, [departmentHeadId], {
        requireActive: true,
      });
      if (!empCheck.ok) return sendError(res, empCheck.status || 400, empCheck.message);
    }

    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO departments (
         company_id, name, department_code, branch_or_location, description, is_active,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [
        companyId,
        deptName,
        deptCodeParsed.value,
        branchParsed.value,
        descParsed.value,
        isActiveParsed.value,
      ]
    );
    const department = insert.rows[0];
    await lineManagerService.replaceDepartmentLineManagers(client, {
      companyId,
      departmentId: department.id,
      departmentHeadId,
    });
    await client.query('COMMIT');

    await invalidateCompanyDepartments(companyId);

    const [mapped] = await attachLineManagersToDepartments(pool, companyId, [department]);
    return sendSuccess(res, 201, 'Department created successfully.', {
      department: mapped,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    if (error?.code === '23505') {
      return sendError(res, 409, 'Department name already exists for this company.');
    }
    console.error('createDepartment error:', error);
    return sendError(res, 500, 'Something went wrong while creating department.');
  } finally {
    client.release();
  }
}

/** GET /api/v1/departments?company_id= */
async function getDepartments(req, res) {
  const companyId = resolveCompanyId(req);
  if (!companyId) {
    return sendError(res, 400, 'company_id is required and must be a positive integer.');
  }
  const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) {
    return sendError(res, 400, listPagination.error);
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    const listQueryMeta = {
      search,
      noPagination: listPagination.noPagination,
      page: listPagination.noPagination ? null : listPagination.pagination.page,
      limit: listPagination.noPagination ? null : listPagination.pagination.limit,
    };
    const cacheKey = listCacheKey(companyId, listQueryMeta);
    const cachedList = await getCachedJson(cacheKey);
    if (cachedList) {
      return sendSuccess(res, 200, 'Departments fetched successfully.', cachedList);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM departments
       WHERE company_id = $1
         AND (
           $2::text = ''
           OR name ILIKE $2
           OR COALESCE(department_code, '') ILIKE $2
           OR COALESCE(branch_or_location, '') ILIKE $2
           OR COALESCE(description, '') ILIKE $2
         )`,
      [companyId, hasSearch ? searchLike : '']
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `SELECT d.*,
                  ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                  ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}
           FROM departments d
           WHERE d.company_id = $1
             AND (
               $2::text = ''
               OR d.name ILIKE $2
               OR COALESCE(d.department_code, '') ILIKE $2
               OR COALESCE(d.branch_or_location, '') ILIKE $2
               OR COALESCE(d.description, '') ILIKE $2
             )
           ORDER BY d.name ASC`,
          [companyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `SELECT d.*,
                  ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                  ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}
           FROM departments d
           WHERE d.company_id = $1
             AND (
               $2::text = ''
               OR d.name ILIKE $2
               OR COALESCE(d.department_code, '') ILIKE $2
               OR COALESCE(d.branch_or_location, '') ILIKE $2
               OR COALESCE(d.description, '') ILIKE $2
             )
           ORDER BY d.name ASC
           LIMIT $3 OFFSET $4`,
          [companyId, hasSearch ? searchLike : '', listPagination.pagination.limit, listPagination.pagination.offset]
        );

    const departments = await attachLineManagersToDepartments(pool, companyId, result.rows);
    const responseData = {
      departments,
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    };
    await setCachedJson(cacheKey, responseData);

    return sendSuccess(res, 200, 'Departments fetched successfully.', responseData);
  } catch (error) {
    console.error('getDepartments error:', error);
    return sendError(res, 500, 'Something went wrong while fetching departments.');
  }
}

/** GET /api/v1/departments/:id?company_id= */
async function getDepartmentById(req, res) {
  const deptId = parsePositiveInt(req.params.id);
  if (!deptId) return sendError(res, 400, 'Department id must be a positive integer.');
  const companyId = req.query?.company_id ? parsePositiveInt(req.query.company_id) : null;
  if (req.query?.company_id && !companyId) {
    return sendError(res, 400, 'company_id query parameter must be a positive integer when provided.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    if (companyId) {
      const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
      if (!access.ok) return sendError(res, 403, access.message);
    }

    const detailScopeKey = companyId ? String(companyId) : `admin:${auth.admin.id}`;
    const cacheKey = detailCacheKey(deptId, detailScopeKey);
    const cachedDetail = await getCachedJson(cacheKey);
    if (cachedDetail) {
      return sendSuccess(res, 200, 'Department fetched successfully.', cachedDetail);
    }

    let result;
    if (companyId) {
      result = await pool.query(
        `SELECT d.*,
                ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}
         FROM departments d
         WHERE d.id = $1 AND d.company_id = $2`,
        [deptId, companyId]
      );
    } else {
      result = await pool.query(
        `SELECT d.*,
                ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}
         FROM departments d
         WHERE d.id = $1
           AND d.company_id IN (
             SELECT c.id
             FROM companies c
             WHERE c.is_active = true
               AND (c.super_admin_id = $2 OR ($3::bigint IS NOT NULL AND c.id = $3))
           )`,
        [deptId, auth.admin.id, auth.admin.company_id ?? null]
      );
    }
    if (result.rowCount === 0) return sendError(res, 404, 'Department not found.');

    const row = result.rows[0];
    const resolvedCompanyId = Number(row.company_id);
    const [department] = await attachLineManagersToDepartments(pool, resolvedCompanyId, [row]);
    const responseData = { department };
    await setCachedJson(cacheKey, responseData);

    return sendSuccess(res, 200, 'Department fetched successfully.', responseData);
  } catch (error) {
    console.error('getDepartmentById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching department.');
  }
}

/** PATCH /api/v1/departments/:id */
async function updateDepartment(req, res) {
  const deptId = parsePositiveInt(req.params.id);
  const body = req.body || {};
  const companyId = resolveCompanyId(req);

  if (!deptId) return sendError(res, 400, 'Department id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');

  const allowedKeys = new Set([
    'company_id',
    'name',
    'department_code',
    'branch_or_location',
    'description',
    'is_active',
    'status',
    'line_manager_ids',
    'department_head_id',
    'primary_manager_id',
    'additional_manager_ids',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return sendError(res, 400, `Unknown field "${key}".`);
    }
  }

  const managersParsed = lineManagerService.parseDepartmentManagers(body);
  if (managersParsed.error) return sendError(res, 400, managersParsed.error);
  const managersOmitted = managersParsed.omitted === true;
  const departmentHeadId = managersOmitted ? null : managersParsed.departmentHeadId;

  const updates = [];
  const values = [];
  let idx = 1;

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const deptName = String(body.name || '').trim();
    if (!deptName) return sendError(res, 400, 'name cannot be empty.');
    if (deptName.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');
    updates.push(`name = $${idx++}`);
    values.push(deptName);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'department_code')) {
    const deptCodeParsed = parseOptionalText(body.department_code, 50);
    if (deptCodeParsed.error) {
      return sendError(res, 400, `department_code ${deptCodeParsed.error}`);
    }
    updates.push(`department_code = $${idx++}`);
    values.push(deptCodeParsed.value);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'branch_or_location')) {
    const branchParsed = parseOptionalText(body.branch_or_location, 120);
    if (branchParsed.error) {
      return sendError(res, 400, `branch_or_location ${branchParsed.error}`);
    }
    updates.push(`branch_or_location = $${idx++}`);
    values.push(branchParsed.value);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const descParsed = parseOptionalText(body.description, 2000);
    if (descParsed.error) {
      return sendError(res, 400, `description ${descParsed.error}`);
    }
    updates.push(`description = $${idx++}`);
    values.push(descParsed.value);
  }

  if (
    Object.prototype.hasOwnProperty.call(body, 'is_active') ||
    Object.prototype.hasOwnProperty.call(body, 'status')
  ) {
    const isActiveSource =
      body.is_active !== undefined ? body.is_active : body.status !== undefined ? body.status : undefined;
    const isActiveParsed = parseBooleanFlag(isActiveSource, true);
    if (isActiveParsed.error) return sendError(res, 400, isActiveParsed.error);
    updates.push(`is_active = $${idx++}`);
    values.push(isActiveParsed.value);
  }

  if (updates.length === 0 && managersOmitted) {
    return sendError(res, 400, 'Provide at least one field to update.');
  }

  const client = await pool.connect();
  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    if (!managersOmitted) {
      if (departmentHeadId) {
        const currentIdsResult = await client.query(
          `SELECT employee_id FROM department_line_managers WHERE company_id = $1 AND department_id = $2`,
          [companyId, deptId]
        );
        const alreadyMapped = new Set(currentIdsResult.rows.map((r) => Number(r.employee_id)));
        const newlyAdded = alreadyMapped.has(Number(departmentHeadId)) ? [] : [departmentHeadId];
        const empCheck = await lineManagerService.assertEmployeesInCompany(
          client,
          companyId,
          [departmentHeadId],
          { requireActive: false }
        );
        if (!empCheck.ok) return sendError(res, empCheck.status || 400, empCheck.message);
        if (newlyAdded.length > 0) {
          const activeCheck = await lineManagerService.assertEmployeesInCompany(client, companyId, newlyAdded, {
            requireActive: true,
          });
          if (!activeCheck.ok) return sendError(res, activeCheck.status || 400, activeCheck.message);
        }
      }
    }

    await client.query('BEGIN');

    let updatedRow = null;
    if (updates.length > 0) {
      const updateValues = [...values, deptId, companyId];
      const deptPos = idx++;
      const companyPos = idx++;
      const updated = await client.query(
        `UPDATE departments d
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE d.id = $${deptPos} AND d.company_id = $${companyPos}
         RETURNING d.*,
                   ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                   ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}`,
        updateValues
      );
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Department not found.');
      }
      updatedRow = updated.rows[0];
    } else {
      const existing = await client.query(
        `SELECT d.*,
                ${DEPARTMENT_EMPLOYEES_COUNT_SQL},
                ${DEPARTMENT_SUB_DEPTS_COUNT_SQL}
         FROM departments d
         WHERE d.id = $1 AND d.company_id = $2`,
        [deptId, companyId]
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Department not found.');
      }
      updatedRow = existing.rows[0];
    }

    if (!managersOmitted) {
      const removalCheck = await lineManagerService.assertCanRemoveDepartmentLineManagers(client, {
        companyId,
        departmentId: deptId,
        departmentHeadId,
      });
      if (!removalCheck.ok) {
        await client.query('ROLLBACK');
        return sendError(res, removalCheck.status || 409, removalCheck.message);
      }
      await lineManagerService.replaceDepartmentLineManagers(client, {
        companyId,
        departmentId: deptId,
        departmentHeadId,
      });
      await client.query(`UPDATE departments SET updated_at = NOW() WHERE id = $1 AND company_id = $2`, [
        deptId,
        companyId,
      ]);
    }

    await client.query('COMMIT');
    await invalidateCompanyDepartments(companyId);

    const [department] = await attachLineManagersToDepartments(pool, companyId, [updatedRow]);
    return sendSuccess(res, 200, 'Department updated successfully.', {
      department,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    if (error?.code === '23505') {
      return sendError(res, 409, 'Department name already exists for this company.');
    }
    console.error('updateDepartment error:', error);
    return sendError(res, 500, 'Something went wrong while updating department.');
  } finally {
    client.release();
  }
}

/** GET /api/v1/departments/summary?company_id= */
async function getDepartmentSummary(req, res) {
  const companyId = resolveCompanyId(req);
  if (!companyId) {
    return sendError(res, 400, 'company_id is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    const cacheKey = summaryCacheKey(companyId);
    const cachedSummary = await getCachedJson(cacheKey);
    if (cachedSummary) {
      return sendSuccess(res, 200, 'Department summary fetched successfully.', cachedSummary);
    }

    const summary = await pool.query(
      `SELECT
         COUNT(*)::int AS total_departments,
         COUNT(*) FILTER (WHERE is_active = true)::int AS active_departments,
         COUNT(*) FILTER (WHERE is_active = false)::int AS inactive_departments
       FROM departments
       WHERE company_id = $1`,
      [companyId]
    );

    const responseData = {
      summary: summary.rows[0],
    };
    await setCachedJson(cacheKey, responseData);

    return sendSuccess(res, 200, 'Department summary fetched successfully.', responseData);
  } catch (error) {
    console.error('getDepartmentSummary error:', error);
    return sendError(res, 500, 'Something went wrong while fetching department summary.');
  }
}

/** PATCH /api/v1/departments/:id/status */
async function updateDepartmentStatus(req, res) {
  const deptId = parsePositiveInt(req.params.id);
  const { status } = req.body || {};
  const companyId = resolveCompanyId(req);
  if (!deptId) return sendError(res, 400, 'Department id must be a positive integer.');
  if (!companyId) return sendError(res, 400, 'company_id is required and must be a positive integer.');
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus !== 'active' && normalizedStatus !== 'inactive') {
    return sendError(res, 400, 'status must be either "active" or "inactive".');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    const updated = await pool.query(
      `UPDATE departments
       SET is_active = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [normalizedStatus === 'active', deptId, companyId]
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Department not found.');

    await invalidateCompanyDepartments(companyId);

    const [department] = await attachLineManagersToDepartments(pool, companyId, updated.rows);
    return sendSuccess(res, 200, 'Department status updated successfully.', {
      department,
    });
  } catch (error) {
    console.error('updateDepartmentStatus error:', error);
    return sendError(res, 500, 'Something went wrong while updating department status.');
  }
}

/** DELETE /api/v1/departments/:id */
async function deleteDepartment(req, res) {
  const deptId = parsePositiveInt(req.params.id);
  const companyId = resolveCompanyId(req);
  if (!deptId) return sendError(res, 400, 'Department id must be a positive integer.');
  if (!companyId) {
    return sendError(res, 400, 'company_id is required and must be a positive integer.');
  }

  try {
    const auth = await getAuthenticatedCompanyAdmin(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const access = await canAdminAccessCompany(auth.admin, companyId, req.authUser?.companyId);
    if (!access.ok) return sendError(res, 403, access.message);

    const deleted = await pool.query(
      `DELETE FROM departments
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [deptId, companyId]
    );
    if (deleted.rowCount === 0) return sendError(res, 404, 'Department not found.');

    await invalidateCompanyDepartments(companyId);

    return sendSuccess(res, 200, 'Department deleted successfully.', {
      department: mapDepartmentRow(deleted.rows[0], { ids: [], managers: [] }),
    });
  } catch (error) {
    console.error('deleteDepartment error:', error);
    return sendError(res, 500, 'Something went wrong while deleting department.');
  }
}

module.exports = {
  createDepartment,
  getDepartments,
  getDepartmentSummary,
  getDepartmentById,
  updateDepartment,
  updateDepartmentStatus,
  deleteDepartment,
};
