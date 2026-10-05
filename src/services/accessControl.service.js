const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { invalidateAllAuthContexts } = require('./permissionsCache.service');
const {
  allModuleKeys,
  emptyPermissionsMatrix,
  fullPermissionsMatrix,
  normalizePermissionMatrix,
  matrixToDbRows,
  ACCESS_ROLE_TEMPLATES,
} = require('../constants/accessRoleTemplates');

function rowsToMatrix(rows) {
  const matrix = emptyPermissionsMatrix();
  for (const row of rows) {
    const key = row.module_key;
    if (!matrix[key]) {
      // Module key not in seed - add it dynamically to avoid silently dropping permissions
      // This handles cases where system_modules table has extra modules not in seed
      matrix[key] = { view: false, add: false, edit: false, delete: false };
    }
    matrix[key] = {
      view: row.can_view === true,
      add: row.can_add === true,
      edit: row.can_edit === true,
      delete: row.can_delete === true,
    };
  }
  return matrix;
}

/** Main Modules → Dashboard (hr_dashboard) also grants every other *_dashboard module. */
function dashboardModuleKeys() {
  return allModuleKeys().filter((key) => key === 'hr_dashboard' || String(key).endsWith('_dashboard'));
}

function applyMainDashboardSync(matrix) {
  if (!matrix || typeof matrix !== 'object') return matrix;
  const primary = matrix.hr_dashboard;
  if (!primary) return matrix;

  const next = { ...matrix };
  for (const key of dashboardModuleKeys()) {
    if (key === 'hr_dashboard') continue;
    const current = next[key] || { view: false, add: false, edit: false, delete: false };
    next[key] = {
      view: primary.view === true || current.view === true,
      add: primary.add === true || current.add === true,
      edit: primary.edit === true || current.edit === true,
      delete: primary.delete === true || current.delete === true,
    };
  }
  return next;
}

/** Clears cached per-user auth contexts so role permission edits apply promptly. */
async function invalidateRoleCache(_roleId) {
  invalidateAllAuthContexts();
  return undefined;
}

async function loadPermissionsByRoleId(roleId) {
  if (!roleId) return emptyPermissionsMatrix();

  const result = await pool.query(
    `SELECT module_key, can_view, can_add, can_edit, can_delete
     FROM access_role_permissions
     WHERE access_role_id = $1`,
    [roleId]
  );

  return applyMainDashboardSync(rowsToMatrix(result.rows));
}

function legacyRoleToTemplateName(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === USER_ROLES.COMPANY_ADMIN) return 'Company Admin';
  if (r === USER_ROLES.DEPARTMENT_MANAGER) return 'Department Manager';
  if (r === USER_ROLES.EMPLOYEE) return 'Employee';
  if (r === USER_ROLES.ADMIN || r === USER_ROLES.HR || r === USER_ROLES.MANAGER) return 'HR Manager';
  return null;
}

function templateMatrixByName(name) {
  const template = ACCESS_ROLE_TEMPLATES.find((t) => t.name === name);
  return template ? normalizePermissionMatrix(template.matrix) : null;
}

async function loadLegacyFallbackPermissions(userRow) {
  const templateName = legacyRoleToTemplateName(userRow.role);
  if (!templateName) return emptyPermissionsMatrix();

  const fromTemplate = templateMatrixByName(templateName);
  if (fromTemplate) return fromTemplate;

  if (!userRow.company_id) return emptyPermissionsMatrix();

  const result = await pool.query(
    `SELECT ar.id
     FROM access_roles ar
     WHERE ar.company_id = $1 AND ar.name = $2
     LIMIT 1`,
    [userRow.company_id, templateName]
  );
  if (result.rowCount === 0) return emptyPermissionsMatrix();
  return loadPermissionsByRoleId(result.rows[0].id);
}

async function getEffectivePermissions(userRow) {
  if (!userRow) return emptyPermissionsMatrix();
  if (String(userRow.role).trim().toLowerCase() === USER_ROLES.SUPER_ADMIN) {
    return fullPermissionsMatrix();
  }
  if (userRow.access_role_id) {
    return loadPermissionsByRoleId(userRow.access_role_id);
  }
  return applyMainDashboardSync(await loadLegacyFallbackPermissions(userRow));
}

function hasPermission(permissions, moduleKey, action) {
  if (!permissions || !moduleKey || !action) return false;
  if (permissions?.[moduleKey]?.[action] === true) return true;
  // Main Modules Dashboard covers all other dashboard modules.
  if (
    moduleKey !== 'hr_dashboard' &&
    String(moduleKey).endsWith('_dashboard') &&
    permissions?.hr_dashboard?.[action] === true
  ) {
    return true;
  }
  // expense_categories isn't in the role-permission module catalog yet, so no
  // role can ever be granted it — default to viewable so employees can still
  // pick a category on the Financial request form. Only applies when the role
  // has no entry for it at all; an explicit grant/deny (once configurable) wins.
  if (moduleKey === 'expense_categories' && action === 'view' && permissions[moduleKey] === undefined) {
    return true;
  }
  return false;
}

function assertPermission(permissions, moduleKey, action) {
  if (hasPermission(permissions, moduleKey, action)) return null;
  const label = String(moduleKey || 'module').replace(/_/g, ' ');
  return {
    status: 403,
    message: `You do not have permission to ${action} ${label}.`,
  };
}

async function loadAccessRoleMeta(userRow) {
  if (!userRow?.access_role_id) {
    const templateName = legacyRoleToTemplateName(userRow?.role);
    return {
      access_role_id: null,
      access_role_name: templateName,
    };
  }

  const result = await pool.query(
    `SELECT id, name FROM access_roles WHERE id = $1 LIMIT 1`,
    [userRow.access_role_id]
  );
  if (result.rowCount === 0) {
    return { access_role_id: userRow.access_role_id, access_role_name: null };
  }
  return {
    access_role_id: Number(result.rows[0].id),
    access_role_name: result.rows[0].name,
  };
}

async function buildAuthPermissionPayload(userRow) {
  const [permissions, roleMeta] = await Promise.all([
    getEffectivePermissions(userRow),
    loadAccessRoleMeta(userRow),
  ]);
  return { permissions, ...roleMeta };
}

module.exports = {
  allModuleKeys,
  emptyPermissionsMatrix,
  fullPermissionsMatrix,
  normalizePermissionMatrix,
  matrixToDbRows,
  loadPermissionsByRoleId,
  getEffectivePermissions,
  hasPermission,
  assertPermission,
  buildAuthPermissionPayload,
  invalidateRoleCache,
  applyMainDashboardSync,
};
