const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { HR_REQUEST_ROLES } = require('./requests.service');

const ESS_ROLES = new Set([USER_ROLES.EMPLOYEE, USER_ROLES.DEPARTMENT_MANAGER]);

async function getAuthenticatedEmployeeContext(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id, employee_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const user = result.rows[0];
  if (!ESS_ROLES.has(user.role)) {
    return { error: [403, 'Only an employee can perform this action.'] };
  }
  if (!user.is_active || !user.company_id || !user.employee_id) {
    return { error: [403, 'Your account must be active and linked to an employee profile.'] };
  }

  return {
    user,
    userId: Number(user.id),
    employeeId: Number(user.employee_id),
    companyId: Number(user.company_id),
  };
}

async function getHrReviewerContext(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const user = result.rows[0];
  if (!user.is_active) return { error: [403, 'Your account is inactive.'] };
  if (!HR_REQUEST_ROLES.has(user.role)) {
    return { error: [403, 'You do not have permission to manage documents.'] };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: [403, 'Your account must be linked to a company.'] };
  }

  return { user, userId: Number(user.id), companyId: user.company_id ? Number(user.company_id) : null };
}

async function resolveDocumentCompanyScope(authUser, query = {}) {
  const auth = await getHrReviewerContext(authUser);
  if (auth.error) return auth;

  if (auth.user.role === USER_ROLES.SUPER_ADMIN) {
    const queryCompanyId = parsePositiveInt(query.company_id);
    if (!queryCompanyId) {
      return { error: [400, 'company_id is required for document management.'] };
    }
    return { ...auth, companyId: queryCompanyId };
  }

  if (!auth.companyId) {
    return { error: [403, 'Your account must be linked to a company.'] };
  }

  return auth;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

module.exports = {
  getAuthenticatedEmployeeContext,
  getHrReviewerContext,
  resolveDocumentCompanyScope,
  parsePositiveInt,
};
