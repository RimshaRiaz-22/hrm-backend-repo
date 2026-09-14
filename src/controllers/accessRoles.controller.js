const { sendSuccess, sendError } = require('../utils/apiResponse');
const systemModulesService = require('../services/systemModules.service');
const accessRolesService = require('../services/accessRoles.service');
const { hasPermission } = require('../services/accessControl.service');
const { USER_ROLES } = require('../constants/userRoles');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function canManageAccessRoles(req) {
  if (!req.authUser) return false;
  if (req.authUser.role === USER_ROLES.SUPER_ADMIN) return true;
  if (req.authUser.role === USER_ROLES.COMPANY_ADMIN) return true;
  return hasPermission(req.permissions, 'access_roles', 'view');
}

function requireAccessRolesCapability(action) {
  return (req, res, next) => {
    if (!req.authUser) {
      return sendError(res, 401, 'Authorization token is required.');
    }
    if (req.authUser.role === USER_ROLES.SUPER_ADMIN) return next();
    if (req.authUser.role === USER_ROLES.COMPANY_ADMIN) return next();
    if (!hasPermission(req.permissions, 'access_roles', action)) {
      return sendError(res, 403, `You do not have permission to ${action} access roles.`);
    }
    return next();
  };
}

async function listSystemModules(req, res) {
  try {
    const modules = await systemModulesService.listActiveModules();
    return sendSuccess(res, 200, 'System modules fetched successfully.', { modules });
  } catch (error) {
    console.error('listSystemModules error:', error);
    return sendError(res, 500, 'Something went wrong while fetching system modules.');
  }
}

async function listAccessRoles(req, res) {
  if (!canManageAccessRoles(req)) {
    return sendError(res, 403, 'You do not have permission to view access roles.');
  }
  try {
    const result = await accessRolesService.listAccessRoles(req.authUser, req.query);
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 200, 'Access roles fetched successfully.', result);
  } catch (error) {
    console.error('listAccessRoles error:', error);
    return sendError(res, 500, 'Something went wrong while fetching access roles.');
  }
}

async function getAccessRoleById(req, res) {
  if (!canManageAccessRoles(req)) {
    return sendError(res, 403, 'You do not have permission to view access roles.');
  }
  const roleId = parsePositiveInt(req.params.id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');

  try {
    const result = await accessRolesService.getAccessRoleById(
      req.authUser,
      roleId,
      req.query?.company_id
    );
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 200, 'Access role fetched successfully.', result);
  } catch (error) {
    console.error('getAccessRoleById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching access role.');
  }
}

async function createAccessRole(req, res) {
  try {
    const result = await accessRolesService.createAccessRole(req.authUser, req.body);
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 201, 'Access role created successfully.', result);
  } catch (error) {
    console.error('createAccessRole error:', error);
    return sendError(res, 500, 'Something went wrong while creating access role.');
  }
}

async function updateAccessRole(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');

  try {
    const result = await accessRolesService.updateAccessRole(req.authUser, roleId, req.body);
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 200, 'Access role updated successfully.', result);
  } catch (error) {
    console.error('updateAccessRole error:', error);
    return sendError(res, 500, 'Something went wrong while updating access role.');
  }
}

async function saveAccessRolePermissions(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');

  try {
    const result = await accessRolesService.saveAccessRolePermissions(
      req.authUser,
      roleId,
      req.body
    );
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 200, 'Access role permissions saved successfully.', result);
  } catch (error) {
    console.error('saveAccessRolePermissions error:', error);
    return sendError(res, 500, 'Something went wrong while saving access role permissions.');
  }
}

async function deleteAccessRole(req, res) {
  const roleId = parsePositiveInt(req.params.id);
  if (!roleId) return sendError(res, 400, 'Role id must be a positive integer.');

  try {
    const result = await accessRolesService.deleteAccessRole(
      req.authUser,
      roleId,
      req.query?.company_id
    );
    if (result.error) return sendError(res, result.status || 400, result.error);
    return sendSuccess(res, 200, 'Access role deleted successfully.', result);
  } catch (error) {
    console.error('deleteAccessRole error:', error);
    return sendError(res, 500, 'Something went wrong while deleting access role.');
  }
}

module.exports = {
  listSystemModules,
  listAccessRoles,
  getAccessRoleById,
  createAccessRole,
  updateAccessRole,
  saveAccessRolePermissions,
  deleteAccessRole,
  requireAccessRolesCapability,
};
