'use strict';

const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const orgChartService = require('../services/orgChart.service');

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

function resolveCompanyId(admin, tokenCompanyId) {
  return (
    orgChartService.parsePositiveInt(admin.company_id) ||
    orgChartService.parsePositiveInt(tokenCompanyId) ||
    null
  );
}

async function resolveAuthCompany(req) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return { error: auth.error };

  const companyId = resolveCompanyId(auth.admin, req.authUser?.companyId);
  if (!companyId) {
    return { error: [400, 'Your account is not linked to a company.'] };
  }
  return { admin: auth.admin, companyId };
}

/** GET /api/v1/org-chart/root */
async function getRoot(req, res) {
  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getOrgChartRoot(pool, auth.companyId);
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Org chart root fetched successfully.', data);
  } catch (error) {
    console.error('getOrgChartRoot error:', error);
    return sendError(res, 500, 'Something went wrong while fetching org chart.');
  }
}

/** GET /api/v1/org-chart/departments/:departmentId/managers */
async function getManagers(req, res) {
  const departmentId = orgChartService.parsePositiveInt(req.params.departmentId);
  if (!departmentId) {
    return sendError(res, 400, 'departmentId must be a positive integer.');
  }

  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getDepartmentManagers(pool, auth.companyId, departmentId);
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Department managers fetched successfully.', data);
  } catch (error) {
    console.error('getDepartmentManagers error:', error);
    return sendError(res, 500, 'Something went wrong while fetching department managers.');
  }
}

/** GET /api/v1/org-chart/departments/:departmentId/managers/:managerId/reports */
async function getReports(req, res) {
  const departmentId = orgChartService.parsePositiveInt(req.params.departmentId);
  const managerId = orgChartService.parsePositiveInt(req.params.managerId);
  if (!departmentId) {
    return sendError(res, 400, 'departmentId must be a positive integer.');
  }
  if (!managerId) {
    return sendError(res, 400, 'managerId must be a positive integer.');
  }

  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getManagerReports(
      pool,
      auth.companyId,
      departmentId,
      managerId
    );
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Manager reports fetched successfully.', data);
  } catch (error) {
    console.error('getManagerReports error:', error);
    return sendError(res, 500, 'Something went wrong while fetching manager reports.');
  }
}

/** GET /api/v1/org-chart/departments/:departmentId/unassigned */
async function getUnassigned(req, res) {
  const departmentId = orgChartService.parsePositiveInt(req.params.departmentId);
  if (!departmentId) {
    return sendError(res, 400, 'departmentId must be a positive integer.');
  }

  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getDepartmentUnassigned(
      pool,
      auth.companyId,
      departmentId
    );
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Unassigned employees fetched successfully.', data);
  } catch (error) {
    console.error('getDepartmentUnassigned error:', error);
    return sendError(res, 500, 'Something went wrong while fetching unassigned employees.');
  }
}

/** GET /api/v1/org-chart/departments — expand Departments group */
async function getDepartments(req, res) {
  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getDepartmentsGroup(pool, auth.companyId);
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Departments fetched successfully.', data);
  } catch (error) {
    console.error('getDepartmentsGroup error:', error);
    return sendError(res, 500, 'Something went wrong while fetching departments.');
  }
}

/** GET /api/v1/org-chart/roles/:accessRoleId/members */
async function getRoleMembers(req, res) {
  const accessRoleId = orgChartService.parsePositiveInt(req.params.accessRoleId);
  if (!accessRoleId) {
    return sendError(res, 400, 'accessRoleId must be a positive integer.');
  }

  try {
    const auth = await resolveAuthCompany(req);
    if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

    const data = await orgChartService.getAccessRoleMembers(
      pool,
      auth.companyId,
      accessRoleId
    );
    if (data.error) return sendError(res, data.error[0], data.error[1]);

    return sendSuccess(res, 200, 'Access role members fetched successfully.', data);
  } catch (error) {
    console.error('getAccessRoleMembers error:', error);
    return sendError(res, 500, 'Something went wrong while fetching access role members.');
  }
}

module.exports = {
  getRoot,
  getDepartments,
  getManagers,
  getReports,
  getUnassigned,
  getRoleMembers,
};
