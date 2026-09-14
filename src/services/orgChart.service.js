'use strict';

const {
  loadLineManagersByDepartmentIds,
  mapLineManagerEmployeeRow,
} = require('./lineManager.service');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function buildNodeId(type, ...parts) {
  return [type, ...parts.map(String)].join('-');
}

function mapEmployeeBrief(row) {
  const first = row.first_name != null ? String(row.first_name).trim() : '';
  const last = row.last_name != null ? String(row.last_name).trim() : '';
  const name = `${first} ${last}`.trim() || null;
  return {
    id: Number(row.id),
    name,
    email: row.work_email ?? null,
    employee_no: row.employee_code ?? row.employee_id ?? null,
    designation: row.designation_name ?? row.designation ?? null,
  };
}

const DEPARTMENTS_GROUP_ID = 'departments-group';

/** Access roles that are the company root or the default employee portal — not sibling boxes. */
const EXCLUDED_ACCESS_ROLE_NAMES = new Set(['company admin', 'employee']);

function isExcludedAccessRoleName(name) {
  return EXCLUDED_ACCESS_ROLE_NAMES.has(String(name || '').trim().toLowerCase());
}

async function listDepartmentNodes(db, companyId) {
  const deptResult = await db.query(
    `SELECT d.id,
            d.name,
            d.department_code,
            COUNT(DISTINCT ejd.employee_id)::int AS employees_count,
            COUNT(DISTINCT dlm.employee_id)::int AS managers_count,
            (
              SELECT COUNT(*)::int
              FROM employees e2
              JOIN employee_job_details ejd2 ON ejd2.employee_id = e2.id
              WHERE e2.company_id = d.company_id
                AND ejd2.department_id = d.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM employee_line_managers elm
                  WHERE elm.company_id = e2.company_id
                    AND elm.employee_id = e2.id
                )
            ) AS unassigned_count
     FROM departments d
     LEFT JOIN employee_job_details ejd ON ejd.department_id = d.id
     LEFT JOIN department_line_managers dlm
       ON dlm.department_id = d.id AND dlm.company_id = d.company_id
     WHERE d.company_id = $1
       AND d.is_active = TRUE
     GROUP BY d.id
     ORDER BY d.name ASC`,
    [companyId]
  );

  return deptResult.rows.map((row) => {
    const managersCount = Number(row.managers_count) || 0;
    const unassignedCount = Number(row.unassigned_count) || 0;
    return {
      id: buildNodeId('dept', row.id),
      type: 'department',
      entity_id: Number(row.id),
      label: row.name,
      meta: {
        department_code: row.department_code ?? null,
        employees_count: Number(row.employees_count) || 0,
        managers_count: managersCount,
        unassigned_count: unassignedCount,
      },
      has_children: managersCount > 0,
      children_loaded: false,
    };
  });
}

async function listStaffAccessRoleNodes(db, companyId) {
  const result = await db.query(
    `SELECT ar.id,
            ar.name,
            ar.description,
            COUNT(u.id) FILTER (
              WHERE u.is_active = TRUE
                AND COALESCE(u.role, '') <> 'company_admin'
            )::int AS members_count
     FROM access_roles ar
     LEFT JOIN users u
       ON u.access_role_id = ar.id
      AND u.company_id = ar.company_id
     WHERE ar.company_id = $1
     GROUP BY ar.id
     ORDER BY ar.name ASC`,
    [companyId]
  );

  return result.rows
    .filter((row) => !isExcludedAccessRoleName(row.name))
    .map((row) => {
      const membersCount = Number(row.members_count) || 0;
      return {
        id: buildNodeId('role', row.id),
        type: 'access_role',
        entity_id: Number(row.id),
        label: row.name,
        meta: {
          description: row.description ?? null,
          members_count: membersCount,
        },
        has_children: membersCount > 0,
        children_loaded: false,
      };
    });
}

/**
 * Company root with:
 *   - Company Admin — then Departments reporting tree
 *   - Staff access roles (HR, Marketing, …)
 */
async function getOrgChartRoot(db, companyId) {
  const companyResult = await db.query(
    `SELECT id, name, logo_url
     FROM companies
     WHERE id = $1`,
    [companyId]
  );
  if (companyResult.rowCount === 0) {
    return { error: [404, 'Company not found.'] };
  }
  const company = companyResult.rows[0];

  const [departments, accessRoles] = await Promise.all([
    listDepartmentNodes(db, companyId),
    listStaffAccessRoleNodes(db, companyId),
  ]);

  const companyAdminNode = {
    id: buildNodeId('companyadmin', company.id),
    type: 'company_admin',
    entity_id: Number(company.id),
    label: 'Company Admin',
    meta: {
      departments_count: departments.length,
    },
    has_children: true,
    children_loaded: true,
  };

  const departmentsGroup = {
    id: DEPARTMENTS_GROUP_ID,
    type: 'departments_group',
    entity_id: null,
    label: 'Departments',
    meta: {
      departments_count: departments.length,
      parent_id: companyAdminNode.id,
    },
    has_children: departments.length > 0,
    children_loaded: false,
  };

  return {
    node: {
      id: buildNodeId('company', company.id),
      type: 'company',
      entity_id: Number(company.id),
      label: company.name,
      meta: {
        logo_url: company.logo_url ?? null,
        departments_count: departments.length,
        access_roles_count: accessRoles.length,
      },
      has_children: true,
      children_loaded: true,
    },
    children: [companyAdminNode, ...accessRoles],
    departments_group: departmentsGroup,
  };
}

/**
 * Expand the Departments group → department nodes.
 */
async function getDepartmentsGroup(db, companyId) {
  const departments = await listDepartmentNodes(db, companyId);
  return {
    node: {
      id: DEPARTMENTS_GROUP_ID,
      type: 'departments_group',
      entity_id: null,
      label: 'Departments',
      meta: { departments_count: departments.length },
      has_children: departments.length > 0,
      children_loaded: true,
    },
    children: departments,
  };
}

/**
 * People assigned to a staff access role (HR, Admin, …).
 */
async function getAccessRoleMembers(db, companyId, accessRoleId) {
  const roleCheck = await db.query(
    `SELECT id, name, description
     FROM access_roles
     WHERE id = $1 AND company_id = $2`,
    [accessRoleId, companyId]
  );
  if (roleCheck.rowCount === 0) {
    return { error: [404, 'Access role not found.'] };
  }

  const role = roleCheck.rows[0];
  if (isExcludedAccessRoleName(role.name)) {
    return { error: [400, 'This access role is not shown as an org-chart staff box.'] };
  }

  const withUsers = await db.query(
    `SELECT u.id AS user_id,
            e.id AS employee_id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id AS employee_code_alt,
            ejd.designation,
            des.name AS designation_name,
            d.name AS department_name,
            u.full_name AS user_full_name,
            u.email AS user_email
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id AND e.company_id = u.company_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN designations des ON des.id = ejd.designation_id
     LEFT JOIN departments d ON d.id = ejd.department_id
     WHERE u.company_id = $1
       AND u.access_role_id = $2
       AND u.is_active = TRUE
       AND COALESCE(u.role, '') <> 'company_admin'
     ORDER BY
       COALESCE(
         NULLIF(TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))), ''),
         u.full_name,
         u.email
       ) ASC`,
    [companyId, accessRoleId]
  );

  const memberChildren = withUsers.rows.map((row) => {
    const first = row.first_name != null ? String(row.first_name).trim() : '';
    const last = row.last_name != null ? String(row.last_name).trim() : '';
    const employeeName = `${first} ${last}`.trim();
    const name = employeeName || row.user_full_name || row.user_email || 'User';
    const employeeId = row.employee_id != null ? Number(row.employee_id) : null;
    const userId = Number(row.user_id);

    return {
      id: buildNodeId('rolemem', accessRoleId, employeeId || `u${userId}`),
      type: 'role_member',
      entity_id: employeeId || userId,
      label: name,
      meta: {
        user_id: userId,
        employee_id: employeeId,
        email: row.work_email || row.user_email || null,
        employee_no: row.employee_code || row.employee_code_alt || null,
        designation: row.designation_name || row.designation || null,
        department: row.department_name || null,
        access_role_id: accessRoleId,
        access_role_name: role.name,
      },
      has_children: false,
      children_loaded: true,
    };
  });

  return {
    node: {
      id: buildNodeId('role', accessRoleId),
      type: 'access_role',
      entity_id: accessRoleId,
      label: role.name,
      meta: {
        description: role.description ?? null,
        members_count: memberChildren.length,
      },
      has_children: memberChildren.length > 0,
      children_loaded: true,
    },
    children: memberChildren,
  };
}

/**
 * Eligible line managers for a department (with dept-scoped primary report counts).
 */
async function getDepartmentManagers(db, companyId, departmentId) {
  const deptCheck = await db.query(
    `SELECT id, name
     FROM departments
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
    [departmentId, companyId]
  );
  if (deptCheck.rowCount === 0) {
    return { error: [404, 'Department not found.'] };
  }

  const managersMap = await loadLineManagersByDepartmentIds(db, companyId, [departmentId]);
  const payload = managersMap.get(departmentId) || { line_managers: [] };
  const managers = payload.line_managers || [];

  let reportCounts = new Map();
  if (managers.length > 0) {
    const managerIds = managers.map((m) => m.id);
    const countResult = await db.query(
      `SELECT elm.manager_id,
              COUNT(*)::int AS reports_count
       FROM employee_line_managers elm
       JOIN employee_job_details ejd ON ejd.employee_id = elm.employee_id
       WHERE elm.company_id = $1
         AND elm.manager_id = ANY($2::bigint[])
         AND elm.manager_role = 'primary'
         AND ejd.department_id = $3
         AND elm.employee_id <> elm.manager_id
       GROUP BY elm.manager_id`,
      [companyId, managerIds, departmentId]
    );
    reportCounts = new Map(
      countResult.rows.map((row) => [Number(row.manager_id), Number(row.reports_count) || 0])
    );
  }

  const children = managers.map((manager) => {
    const reportsCount = reportCounts.get(manager.id) || 0;
    return {
      id: buildNodeId('mgr', departmentId, manager.id),
      type: 'manager',
      entity_id: manager.id,
      label: manager.name,
      meta: {
        email: manager.email,
        employee_no: manager.employee_no,
        designation: manager.designation,
        department: manager.department,
        role: manager.role || null,
        direct_reports_count: reportsCount,
        department_id: departmentId,
      },
      has_children: reportsCount > 0,
      children_loaded: false,
    };
  });

  return {
    node: {
      id: buildNodeId('dept', departmentId),
      type: 'department',
      entity_id: departmentId,
      label: deptCheck.rows[0].name,
      has_children: children.length > 0,
      children_loaded: true,
    },
    children,
  };
}

/**
 * Direct reports for a manager in a department.
 * Tree children = primary reports only (solid edges).
 * additional_links = employees who have this manager as additional (dashed edges).
 */
async function getManagerReports(db, companyId, departmentId, managerId) {
  const deptCheck = await db.query(
    `SELECT id, name
     FROM departments
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
    [departmentId, companyId]
  );
  if (deptCheck.rowCount === 0) {
    return { error: [404, 'Department not found.'] };
  }

  const eligible = await db.query(
    `SELECT 1
     WHERE EXISTS (
       SELECT 1
       FROM department_line_managers
       WHERE company_id = $1
         AND department_id = $2
         AND employee_id = $3
     )
     OR EXISTS (
       SELECT 1
       FROM employee_line_managers elm
       INNER JOIN employee_job_details ejd
         ON ejd.employee_id = elm.employee_id AND ejd.company_id = elm.company_id
       WHERE elm.company_id = $1
         AND ejd.department_id = $2
         AND elm.manager_id = $3
     )`,
    [companyId, departmentId, managerId]
  );
  if (eligible.rowCount === 0) {
    return { error: [404, 'Manager is not assigned to this department.'] };
  }

  const primaryResult = await db.query(
    `SELECT e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id,
            ejd.designation,
            des.name AS designation_name,
            elm.manager_role,
            EXISTS (
              SELECT 1
              FROM employee_line_managers elm2
              INNER JOIN employee_job_details ejd2
                ON ejd2.employee_id = elm2.employee_id AND ejd2.company_id = elm2.company_id
              WHERE elm2.company_id = $1
                AND elm2.manager_id = e.id
                AND elm2.manager_role = 'primary'
                AND ejd2.department_id = $2
                AND elm2.employee_id <> e.id
            ) AS has_primary_reports
     FROM employees e
     JOIN employee_job_details ejd ON ejd.employee_id = e.id
     JOIN employee_line_managers elm
       ON elm.employee_id = e.id AND elm.manager_id = $3 AND elm.company_id = $1
     LEFT JOIN designations des ON des.id = ejd.designation_id
     WHERE e.company_id = $1
       AND ejd.department_id = $2
       AND e.id <> $3
       AND elm.manager_role = 'primary'
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [companyId, departmentId, managerId]
  );

  const primaryIds = primaryResult.rows.map((row) => Number(row.id));
  const additionalByEmployee = new Map();
  if (primaryIds.length > 0) {
    const additionalResult = await db.query(
      `SELECT elm.employee_id, elm.manager_id
       FROM employee_line_managers elm
       WHERE elm.company_id = $1
         AND elm.employee_id = ANY($2::bigint[])
         AND elm.manager_role = 'additional'`,
      [companyId, primaryIds]
    );
    for (const row of additionalResult.rows) {
      const empId = Number(row.employee_id);
      const list = additionalByEmployee.get(empId) || [];
      list.push(Number(row.manager_id));
      additionalByEmployee.set(empId, list);
    }
  }

  const children = primaryResult.rows.map((row) => {
    const brief = mapEmployeeBrief(row);
    const hasChildren = row.has_primary_reports === true;
    return {
      id: buildNodeId('emp', departmentId, managerId, brief.id),
      type: 'employee',
      entity_id: brief.id,
      label: brief.name,
      meta: {
        email: brief.email,
        employee_no: brief.employee_no,
        designation: brief.designation,
        manager_role: 'primary',
        department_id: departmentId,
        manager_id: managerId,
        additional_manager_ids: additionalByEmployee.get(brief.id) || [],
      },
      has_children: hasChildren,
      children_loaded: false,
    };
  });

  const additionalResult = await db.query(
    `SELECT e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id,
            ejd.designation,
            des.name AS designation_name
     FROM employees e
     JOIN employee_job_details ejd ON ejd.employee_id = e.id
     JOIN employee_line_managers elm
       ON elm.employee_id = e.id AND elm.manager_id = $3 AND elm.company_id = $1
     LEFT JOIN designations des ON des.id = ejd.designation_id
     WHERE e.company_id = $1
       AND ejd.department_id = $2
       AND e.id <> $3
       AND elm.manager_role = 'additional'
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [companyId, departmentId, managerId]
  );

  const additional_links = additionalResult.rows.map((row) => {
    const brief = mapEmployeeBrief(row);
    return {
      employee_id: brief.id,
      manager_id: Number(managerId),
      name: brief.name,
      email: brief.email,
      employee_no: brief.employee_no,
      designation: brief.designation,
      manager_role: 'additional',
    };
  });

  return {
    node: {
      id: buildNodeId('mgr', departmentId, managerId),
      type: 'manager',
      entity_id: managerId,
      has_children: children.length > 0,
      children_loaded: true,
    },
    children,
    additional_links,
  };
}

/**
 * Employees in a department with no line manager assignment (sidebar).
 */
async function getDepartmentUnassigned(db, companyId, departmentId) {
  const deptCheck = await db.query(
    `SELECT id, name
     FROM departments
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
    [departmentId, companyId]
  );
  if (deptCheck.rowCount === 0) {
    return { error: [404, 'Department not found.'] };
  }

  const result = await db.query(
    `SELECT e.id,
            e.first_name,
            e.last_name,
            e.work_email,
            e.employee_code,
            e.employee_id,
            ejd.designation,
            des.name AS designation_name
     FROM employees e
     JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN designations des ON des.id = ejd.designation_id
     WHERE e.company_id = $1
       AND ejd.department_id = $2
       AND NOT EXISTS (
         SELECT 1
         FROM employee_line_managers elm
         WHERE elm.company_id = $1
           AND elm.employee_id = e.id
       )
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [companyId, departmentId]
  );

  const employees = result.rows.map((row) => mapEmployeeBrief(row));

  return {
    department: {
      id: departmentId,
      name: deptCheck.rows[0].name,
    },
    unassigned_count: employees.length,
    employees,
  };
}

module.exports = {
  parsePositiveInt,
  buildNodeId,
  mapEmployeeBrief,
  DEPARTMENTS_GROUP_ID,
  getOrgChartRoot,
  getDepartmentsGroup,
  getAccessRoleMembers,
  getDepartmentManagers,
  getManagerReports,
  getDepartmentUnassigned,
  mapLineManagerEmployeeRow,
};
