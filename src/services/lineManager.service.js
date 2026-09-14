'use strict';

/**
 * Pure helpers + DB helpers for department head + employee reporting managers.
 * Department stores a single head; employees assign primary/additional from
 * department members + that head (leave approval uses employee_line_managers).
 */

function parsePositiveInt(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

const MANAGER_ROLES = new Set(['primary', 'additional']);
const DEPARTMENT_HEAD_ROLES = new Set(['head', 'primary']);

/**
 * Parse department head from payload.
 * Preferred: department_head_id
 * Legacy aliases: primary_manager_id, line_manager_ids[0]
 * additional_manager_ids is ignored (department no longer stores additional pools).
 */
function parseDepartmentManagers(body = {}) {
  const hasHead = Object.prototype.hasOwnProperty.call(body, 'department_head_id');
  const hasPrimaryAlias = Object.prototype.hasOwnProperty.call(body, 'primary_manager_id');
  const hasLegacy = Object.prototype.hasOwnProperty.call(body, 'line_manager_ids');
  const hasAdditionalOnly =
    Object.prototype.hasOwnProperty.call(body, 'additional_manager_ids') &&
    !hasHead &&
    !hasPrimaryAlias &&
    !hasLegacy;

  if (!hasHead && !hasPrimaryAlias && !hasLegacy && !hasAdditionalOnly) {
    return { omitted: true };
  }

  // Sending only additional_manager_ids no longer changes the department head.
  if (hasAdditionalOnly) {
    return { omitted: true };
  }

  let departmentHeadId = null;

  if (hasHead) {
    if (body.department_head_id !== null && body.department_head_id !== '') {
      departmentHeadId = parsePositiveInt(body.department_head_id);
      if (!departmentHeadId) {
        return { error: 'department_head_id must be a positive integer or null.' };
      }
    }
  } else if (hasPrimaryAlias) {
    if (body.primary_manager_id !== null && body.primary_manager_id !== '') {
      departmentHeadId = parsePositiveInt(body.primary_manager_id);
      if (!departmentHeadId) {
        return { error: 'primary_manager_id must be a positive integer or null.' };
      }
    }
  } else {
    const legacy = parseLineManagerIds(body.line_manager_ids);
    if (legacy.error) return legacy;
    if (legacy.ids.length > 0) {
      departmentHeadId = legacy.ids[0];
    }
  }

  return {
    omitted: false,
    departmentHeadId,
    // Compat aliases for callers still using primary/additional naming.
    primaryManagerId: departmentHeadId,
    additionalManagerIds: [],
  };
}

function buildDepartmentManagersPayload(rows = []) {
  const headRow =
    rows.find((row) => row.manager_role === 'head') ||
    rows.find((row) => row.manager_role === 'primary') ||
    null;
  const departmentHead = headRow ? mapLineManagerEmployeeRow(headRow) : null;
  const managers = departmentHead
    ? [{ ...departmentHead, role: 'head' }]
    : [];
  const ids = managers.map((manager) => manager.id);

  return {
    ids,
    managers,
    department_head_id: departmentHead ? departmentHead.id : null,
    department_head: departmentHead,
    // Compat aliases for existing frontend / org-chart consumers.
    primary_manager_id: departmentHead ? departmentHead.id : null,
    primary_manager: departmentHead,
    additional_manager_ids: [],
    additional_managers: [],
    line_manager_ids: ids,
    line_managers: managers,
  };
}

/**
 * Parse employee managers from official.line_managers or legacy line_manager_id.
 */
function parseEmployeeLineManagers(official = {}) {
  if (Object.prototype.hasOwnProperty.call(official, 'line_managers')) {
    if (official.line_managers === null) {
      return { omitted: false, assignments: [] };
    }
    if (!Array.isArray(official.line_managers)) {
      return { error: 'line_managers must be an array.' };
    }
    const assignments = [];
    const seen = new Set();
    let primaryCount = 0;
    for (const item of official.line_managers) {
      const managerId = parsePositiveInt(item?.manager_id ?? item?.id);
      const role = String(item?.role || '').trim().toLowerCase();
      if (!managerId) {
        return { error: 'Each line manager must include a positive manager_id.' };
      }
      if (!MANAGER_ROLES.has(role)) {
        return { error: 'Each line manager role must be primary or additional.' };
      }
      if (seen.has(managerId)) {
        return { error: 'line_managers must contain unique manager_id values.' };
      }
      seen.add(managerId);
      if (role === 'primary') primaryCount += 1;
      assignments.push({ managerId, role });
    }
    if (primaryCount > 1) {
      return { error: 'An employee can have at most one primary line manager.' };
    }
    return { omitted: false, assignments };
  }

  const legacy = parseOptionalLineManagerId(
    Object.prototype.hasOwnProperty.call(official, 'line_manager_id') ? official.line_manager_id : undefined
  );
  if (legacy.error) return legacy;
  if (legacy.omitted) return { omitted: true };
  if (legacy.value == null) return { omitted: false, assignments: [] };
  return {
    omitted: false,
    assignments: [{ managerId: legacy.value, role: 'primary' }],
  };
}

function mapEmployeeManagerRow(row) {
  const manager = mapLineManagerEmployeeRow(row);
  if (!manager) return null;
  return {
    ...manager,
    role: row.manager_role,
  };
}

/**
 * Parse department `line_manager_ids` (legacy).
 * - undefined => omitted (PATCH preserve)
 * - [] => clear
 * - array of unique positive ints
 */
function parseLineManagerIds(value) {
  if (value === undefined) {
    return { omitted: true };
  }
  if (!Array.isArray(value)) {
    return { error: 'line_manager_ids must be an array of positive integers.' };
  }
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const n = parsePositiveInt(item);
    if (!n) {
      return { error: 'line_manager_ids must contain only unique positive integers.' };
    }
    if (seen.has(n)) {
      return { error: 'line_manager_ids must contain unique values (duplicate found).' };
    }
    seen.add(n);
    ids.push(n);
  }
  return { omitted: false, ids };
}

/**
 * Parse employee `official.line_manager_id`.
 * - undefined => omitted (PATCH preserve)
 * - null / '' => explicit clear
 * - positive int => set
 */
function parseOptionalLineManagerId(value) {
  if (value === undefined) {
    return { omitted: true };
  }
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return { omitted: false, value: null };
  }
  const n = parsePositiveInt(value);
  if (!n) {
    return { error: 'line_manager_id must be a positive integer or null.' };
  }
  return { omitted: false, value: n };
}

/**
 * Walk the existing manager chain starting at `managerId`.
 * Returns true if assigning `managerId` as manager of `employeeId` would create a cycle.
 * `managerByEmployeeId` is a Map employeeId -> line_manager_id (existing edges; may omit nulls).
 */
function wouldCreateLineManagerCycle(employeeId, managerId, managerByEmployeeId) {
  if (managerId == null) return false;
  const empId = Number(employeeId);
  const mgrId = Number(managerId);
  if (!Number.isInteger(empId) || empId <= 0) return false;
  if (!Number.isInteger(mgrId) || mgrId <= 0) return false;
  if (empId === mgrId) return true;

  const map = managerByEmployeeId instanceof Map ? managerByEmployeeId : new Map();
  const visited = new Set();
  let current = mgrId;
  while (current != null) {
    if (current === empId) return true;
    if (visited.has(current)) return true; // existing cycle in data; treat as unsafe
    visited.add(current);
    const next = map.get(current);
    if (next == null) break;
    current = Number(next);
    if (!Number.isInteger(current) || current <= 0) break;
  }
  return false;
}

/**
 * Decide the effective line_manager_id when department may have changed.
 * If line_manager_id was not provided: keep previous only if still eligible; else clear.
 * If provided: use requested value (caller still validates eligibility).
 */
function resolveLineManagerOnDepartmentChange({
  previousLineManagerId,
  lineManagerIdProvided,
  requestedLineManagerId,
  eligibleManagerIds,
}) {
  if (lineManagerIdProvided) {
    return { lineManagerId: requestedLineManagerId == null ? null : Number(requestedLineManagerId) };
  }
  if (previousLineManagerId == null) {
    return { lineManagerId: null };
  }
  const prev = Number(previousLineManagerId);
  const eligible =
    eligibleManagerIds instanceof Set ? eligibleManagerIds : new Set(eligibleManagerIds || []);
  if (eligible.has(prev)) {
    return { lineManagerId: prev };
  }
  return { lineManagerId: null };
}

function mapLineManagerEmployeeRow(row) {
  if (!row) return null;
  const first = row.first_name != null ? String(row.first_name).trim() : '';
  const last = row.last_name != null ? String(row.last_name).trim() : '';
  const name = `${first} ${last}`.trim() || null;
  return {
    id: Number(row.id),
    name,
    email: row.work_email ?? null,
    employee_no: row.employee_code ?? row.employee_id ?? null,
    department: row.department_name ?? row.department ?? null,
    designation: row.designation_name ?? row.designation ?? null,
  };
}

/**
 * Batch-load eligible line managers for many departments (avoids N+1).
 * Returns Map<departmentId, { ids: number[], managers: object[] }>
 */
async function loadLineManagersByDepartmentIds(db, companyId, departmentIds) {
  const map = new Map();
  const ids = [...new Set((departmentIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of ids) {
    map.set(id, buildDepartmentManagersPayload());
  }
  if (ids.length === 0) return map;

  const result = await db.query(
    `SELECT dlm.department_id,
            dlm.manager_role,
            e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id,
            ejd.department,
            ejd.designation,
            d.name AS department_name,
            des.name AS designation_name
     FROM department_line_managers dlm
     INNER JOIN employees e ON e.id = dlm.employee_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN departments d ON d.id = ejd.department_id
     LEFT JOIN designations des ON des.id = ejd.designation_id
     WHERE dlm.company_id = $1
       AND dlm.department_id = ANY($2::bigint[])
     ORDER BY dlm.department_id ASC,
              CASE
                WHEN dlm.manager_role = 'head' THEN 0
                WHEN dlm.manager_role = 'primary' THEN 0
                ELSE 1
              END,
              e.first_name ASC,
              e.last_name ASC,
              e.id ASC`,
    [companyId, ids]
  );

  const grouped = new Map();
  for (const row of result.rows) {
    const deptId = Number(row.department_id);
    const bucket = grouped.get(deptId) || [];
    bucket.push(row);
    grouped.set(deptId, bucket);
  }

  for (const [deptId, rows] of grouped.entries()) {
    map.set(deptId, buildDepartmentManagersPayload(rows));
  }
  return map;
}

async function replaceDepartmentLineManagers(client, {
  companyId,
  departmentId,
  departmentHeadId,
  primaryManagerId,
}) {
  const headId = departmentHeadId != null ? Number(departmentHeadId) : primaryManagerId != null ? Number(primaryManagerId) : null;

  await client.query(
    `DELETE FROM department_line_managers
     WHERE company_id = $1 AND department_id = $2`,
    [companyId, departmentId]
  );

  if (!headId || !Number.isInteger(headId) || headId <= 0) return;

  await client.query(
    `INSERT INTO department_line_managers (company_id, department_id, employee_id, manager_role, created_at, updated_at)
     VALUES ($1, $2, $3, 'head', NOW(), NOW())`,
    [companyId, departmentId, headId]
  );
}

/** Legacy wrapper: first id becomes department head. */
async function replaceDepartmentLineManagersLegacy(client, { companyId, departmentId, employeeIds }) {
  const ids = [...new Set((employeeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return replaceDepartmentLineManagers(client, {
    companyId,
    departmentId,
    departmentHeadId: ids[0] || null,
  });
}

/**
 * Validate that every employee id belongs to the company.
 * Prefer active employees for NEW selection (users.is_active = true when a user exists),
 * but do not reject inactive ones if they are already stored / still readable — callers
 * that want "selection only" pass requireActive=true.
 */
async function assertEmployeesInCompany(client, companyId, employeeIds, { requireActive = false } = {}) {
  if (!employeeIds || employeeIds.length === 0) return { ok: true };
  const result = await client.query(
    `SELECT e.id,
            COALESCE(u.is_active, true) AS is_active
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id AND u.company_id = e.company_id
     WHERE e.company_id = $1
       AND e.id = ANY($2::bigint[])`,
    [companyId, employeeIds]
  );
  const found = new Map(result.rows.map((r) => [Number(r.id), r.is_active === true]));
  const missing = employeeIds.filter((id) => !found.has(Number(id)));
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      message: `One or more line managers were not found in this company: ${missing.join(', ')}.`,
    };
  }
  if (requireActive) {
    const inactive = employeeIds.filter((id) => found.get(Number(id)) === false);
    if (inactive.length > 0) {
      return {
        ok: false,
        status: 400,
        message: `Line managers must be active employees. Inactive: ${inactive.join(', ')}.`,
      };
    }
  }
  return { ok: true };
}

async function loadDepartmentManagerPools(client, companyId, departmentId) {
  if (departmentId == null) {
    return {
      departmentHeadId: null,
      primaryManagerId: null,
      additionalManagerIds: new Set(),
      allManagerIds: new Set(),
    };
  }
  const result = await client.query(
    `SELECT employee_id, manager_role
     FROM department_line_managers
     WHERE company_id = $1 AND department_id = $2`,
    [companyId, Number(departmentId)]
  );
  let departmentHeadId = null;
  const allManagerIds = new Set();
  for (const row of result.rows) {
    const managerId = Number(row.employee_id);
    allManagerIds.add(managerId);
    if (DEPARTMENT_HEAD_ROLES.has(row.manager_role)) {
      departmentHeadId = managerId;
    }
  }
  return {
    departmentHeadId,
    primaryManagerId: departmentHeadId,
    additionalManagerIds: new Set(),
    allManagerIds,
  };
}

/**
 * Eligible employee managers for a department: all members of the department
 * plus the department head (even if the head belongs to another department).
 */
async function loadEligibleManagerIdsForDepartment(client, companyId, departmentId) {
  const eligible = new Set();
  if (departmentId == null || !Number.isInteger(Number(departmentId)) || Number(departmentId) <= 0) {
    return eligible;
  }

  const pools = await loadDepartmentManagerPools(client, companyId, departmentId);
  if (pools.departmentHeadId != null) {
    eligible.add(Number(pools.departmentHeadId));
  }

  const members = await client.query(
    `SELECT e.id
     FROM employees e
     INNER JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND ejd.department_id = $2`,
    [companyId, Number(departmentId)]
  );
  for (const row of members.rows) {
    eligible.add(Number(row.id));
  }
  return eligible;
}

async function assertCanRemoveDepartmentLineManagers(
  client,
  { companyId, departmentId, departmentHeadId, primaryManagerId }
) {
  const current = await client.query(
    `SELECT employee_id, manager_role
     FROM department_line_managers
     WHERE company_id = $1 AND department_id = $2`,
    [companyId, departmentId]
  );
  const nextHead =
    departmentHeadId != null
      ? Number(departmentHeadId)
      : primaryManagerId != null
        ? Number(primaryManagerId)
        : null;
  const nextIds = new Set(nextHead != null ? [nextHead] : []);
  const removed = current.rows
    .map((row) => Number(row.employee_id))
    .filter((id) => !nextIds.has(id));
  if (removed.length === 0) return { ok: true };

  // Head who is also a member of the department remains eligible after removal.
  const membersOnly = await client.query(
    `SELECT e.id
     FROM employees e
     INNER JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND ejd.department_id = $2
       AND e.id = ANY($3::bigint[])`,
    [companyId, departmentId, removed]
  );
  const stillMembers = new Set(membersOnly.rows.map((r) => Number(r.id)));
  const blocked = removed.filter((id) => !stillMembers.has(id));
  if (blocked.length === 0) return { ok: true };

  const refs = await client.query(
    `SELECT elm.manager_id, COUNT(*)::int AS assignee_count
     FROM employee_line_managers elm
     INNER JOIN employee_job_details ejd
       ON ejd.employee_id = elm.employee_id AND ejd.company_id = elm.company_id
     WHERE elm.company_id = $1
       AND ejd.department_id = $2
       AND elm.manager_id = ANY($3::bigint[])
     GROUP BY elm.manager_id`,
    [companyId, departmentId, blocked]
  );
  if (refs.rowCount > 0) {
    const details = refs.rows
      .map((r) => `manager ${r.manager_id} (${r.assignee_count} employee(s))`)
      .join(', ');
    return {
      ok: false,
      status: 409,
      message: `Cannot remove department head still assigned to employees in this department: ${details}. Reassign those employees first.`,
    };
  }
  return { ok: true };
}

async function validateEmployeeLineManagersAssignment(client, {
  companyId,
  employeeId,
  departmentId,
  assignments,
}) {
  const empId = employeeId != null ? Number(employeeId) : null;
  const normalizedAssignments = Array.isArray(assignments) ? assignments : [];

  if (normalizedAssignments.length === 0) {
    return { ok: true, assignments: [], primaryLineManagerId: null };
  }

  if (departmentId == null || !Number.isInteger(Number(departmentId)) || Number(departmentId) <= 0) {
    return {
      ok: false,
      status: 400,
      message: 'A department must be selected before assigning line managers.',
    };
  }

  const eligible = await loadEligibleManagerIdsForDepartment(client, companyId, departmentId);
  let primaryLineManagerId = null;

  for (const assignment of normalizedAssignments) {
    const managerId = Number(assignment.managerId);
    const role = assignment.role;
    if (!Number.isInteger(managerId) || managerId <= 0) {
      return { ok: false, status: 400, message: 'Each line manager must include a positive manager_id.' };
    }
    if (empId != null && empId === managerId) {
      return { ok: false, status: 400, message: 'An employee cannot be their own line manager.' };
    }

    const companyCheck = await client.query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [managerId, companyId]
    );
    if (companyCheck.rowCount === 0) {
      return { ok: false, status: 400, message: 'Line manager must belong to the same company.' };
    }

    if (!MANAGER_ROLES.has(role)) {
      return { ok: false, status: 400, message: 'Each line manager role must be primary or additional.' };
    }

    if (!eligible.has(managerId)) {
      return {
        ok: false,
        status: 400,
        message:
          'Line manager must be an employee of the selected department or the department head.',
      };
    }

    if (role === 'primary') {
      primaryLineManagerId = managerId;
    }
  }

  if (empId != null && primaryLineManagerId != null) {
    const chain = await client.query(
      `SELECT employee_id, line_manager_id
       FROM employee_job_details
       WHERE company_id = $1
         AND line_manager_id IS NOT NULL`,
      [companyId]
    );
    const managerByEmployeeId = new Map(
      chain.rows.map((r) => [Number(r.employee_id), Number(r.line_manager_id)])
    );
    if (wouldCreateLineManagerCycle(empId, primaryLineManagerId, managerByEmployeeId)) {
      return {
        ok: false,
        status: 400,
        message: 'Assigning this primary line manager would create a reporting cycle.',
      };
    }
  }

  return { ok: true, assignments: normalizedAssignments, primaryLineManagerId };
}

async function validateEmployeeLineManagerAssignment(client, params) {
  if (Array.isArray(params?.assignments)) {
    return validateEmployeeLineManagersAssignment(client, params);
  }
  const single = await validateEmployeeLineManagersAssignment(client, {
    ...params,
    assignments:
      params?.lineManagerId == null
        ? []
        : [{ managerId: params.lineManagerId, role: 'primary' }],
  });
  if (!single.ok) return single;
  return { ok: true, lineManagerId: single.primaryLineManagerId };
}

function resolveEmployeeManagersOnDepartmentChange({
  previousAssignments,
  managersProvided,
  requestedAssignments,
  eligibleManagerIds,
  departmentPools,
}) {
  if (managersProvided) {
    return { assignments: requestedAssignments || [] };
  }
  const eligible =
    eligibleManagerIds instanceof Set
      ? eligibleManagerIds
      : departmentPools?.allManagerIds instanceof Set
        ? departmentPools.allManagerIds
        : new Set(eligibleManagerIds || departmentPools?.allManagerIds || []);
  const valid = (previousAssignments || []).filter((assignment) =>
    eligible.has(Number(assignment.managerId))
  );
  return { assignments: valid };
}

async function replaceEmployeeLineManagers(client, { companyId, employeeId, assignments }) {
  await client.query(
    `DELETE FROM employee_line_managers
     WHERE company_id = $1 AND employee_id = $2`,
    [companyId, employeeId]
  );

  const rows = Array.isArray(assignments) ? assignments : [];
  if (rows.length === 0) {
    await client.query(
      `UPDATE employee_job_details
       SET line_manager_id = NULL, updated_at = NOW()
       WHERE company_id = $1 AND employee_id = $2`,
      [companyId, employeeId]
    );
    return { primaryLineManagerId: null };
  }

  await client.query(
    `INSERT INTO employee_line_managers (company_id, employee_id, manager_id, manager_role, created_at, updated_at)
     SELECT $1, $2, x.manager_id, x.manager_role, NOW(), NOW()
     FROM UNNEST($3::bigint[], $4::text[]) AS x(manager_id, manager_role)`,
    [
      companyId,
      employeeId,
      rows.map((row) => Number(row.managerId)),
      rows.map((row) => row.role),
    ]
  );

  const primary = rows.find((row) => row.role === 'primary') || null;
  const primaryLineManagerId = primary ? Number(primary.managerId) : null;
  await client.query(
    `UPDATE employee_job_details
     SET line_manager_id = $1, updated_at = NOW()
     WHERE company_id = $2 AND employee_id = $3`,
    [primaryLineManagerId, companyId, employeeId]
  );
  return { primaryLineManagerId };
}

async function loadEmployeeLineManagersByEmployeeIds(db, companyId, employeeIds) {
  const map = new Map();
  const ids = [...new Set((employeeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of ids) {
    map.set(id, { line_managers: [], primaryLineManagerId: null });
  }
  if (ids.length === 0) return map;

  const result = await db.query(
    `SELECT elm.employee_id,
            elm.manager_role,
            e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id AS employee_no,
            ejd.department,
            ejd.designation,
            d.name AS department_name,
            des.name AS designation_name
     FROM employee_line_managers elm
     INNER JOIN employees e ON e.id = elm.manager_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN departments d ON d.id = ejd.department_id
     LEFT JOIN designations des ON des.id = ejd.designation_id
     WHERE elm.company_id = $1
       AND elm.employee_id = ANY($2::bigint[])
     ORDER BY elm.employee_id ASC,
              CASE WHEN elm.manager_role = 'primary' THEN 0 ELSE 1 END,
              e.first_name ASC,
              e.last_name ASC,
              e.id ASC`,
    [companyId, ids]
  );

  for (const row of result.rows) {
    const employeeId = Number(row.employee_id);
    const bucket = map.get(employeeId) || { line_managers: [], primaryLineManagerId: null };
    const manager = mapEmployeeManagerRow(row);
    bucket.line_managers.push(manager);
    if (row.manager_role === 'primary') bucket.primaryLineManagerId = manager.id;
    map.set(employeeId, bucket);
  }
  return map;
}

async function loadEmployeeLineManagersByEmployeeId(db, companyId, employeeId) {
  const map = await loadEmployeeLineManagersByEmployeeIds(db, companyId, [employeeId]);
  return map.get(Number(employeeId)) || { line_managers: [], primaryLineManagerId: null };
}

async function employeeHasDirectReports(client, companyId, managerEmployeeId) {
  const result = await client.query(
    `SELECT 1
     FROM employee_line_managers elm
     WHERE elm.company_id = $1
       AND elm.manager_id = $2
     LIMIT 1`,
    [companyId, managerEmployeeId]
  );
  return result.rowCount > 0;
}

module.exports = {
  parsePositiveInt,
  parseLineManagerIds,
  parseDepartmentManagers,
  parseOptionalLineManagerId,
  parseEmployeeLineManagers,
  wouldCreateLineManagerCycle,
  resolveLineManagerOnDepartmentChange,
  resolveEmployeeManagersOnDepartmentChange,
  mapLineManagerEmployeeRow,
  mapEmployeeManagerRow,
  buildDepartmentManagersPayload,
  loadLineManagersByDepartmentIds,
  loadDepartmentManagerPools,
  replaceDepartmentLineManagers,
  replaceDepartmentLineManagersLegacy,
  replaceEmployeeLineManagers,
  assertEmployeesInCompany,
  assertCanRemoveDepartmentLineManagers,
  validateEmployeeLineManagerAssignment,
  validateEmployeeLineManagersAssignment,
  loadEligibleManagerIdsForDepartment,
  loadEmployeeLineManagersByEmployeeId,
  loadEmployeeLineManagersByEmployeeIds,
  employeeHasDirectReports,
};
