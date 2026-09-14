const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendError } = require('../utils/apiResponse');
const { USER_ROLES } = require('../constants/userRoles');
const {
  getEffectivePermissions,
  hasPermission,
  fullPermissionsMatrix,
} = require('../services/accessControl.service');
const {
  getCachedAuthContext,
  setCachedAuthContext,
} = require('../services/permissionsCache.service');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded.userId || !decoded.email) {
      return sendError(res, 401, 'Invalid token payload.');
    }
    req.authUser = decoded;
    next();
  } catch {
    return sendError(res, 401, 'Invalid or expired token.');
  }
}

async function attachPermissions(req, res, next) {
  if (!req.authUser?.userId || !req.authUser?.email) {
    return next();
  }

  try {
    if (req.authUser.role === USER_ROLES.SUPER_ADMIN) {
      req.permissions = fullPermissionsMatrix();
      return next();
    }

    const cached = getCachedAuthContext(req.authUser.userId);
    if (cached) {
      if (cached.notFound) {
        req.permissions = {};
        return next();
      }
      if (!cached.isActive) {
        return sendError(res, 403, 'Your account is inactive.');
      }
      req.authUser.role = cached.role;
      req.authUser.companyId = cached.companyId ?? req.authUser.companyId ?? null;
      req.authUser.accessRoleId = cached.accessRoleId ?? null;
      req.permissions = cached.permissions;
      return next();
    }

    const result = await pool.query(
      `SELECT id, email, role, company_id, access_role_id, is_active
       FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );

    if (result.rowCount === 0) {
      setCachedAuthContext(req.authUser.userId, { notFound: true });
      req.permissions = {};
      return next();
    }

    const userRow = result.rows[0];
    if (!userRow.is_active) {
      setCachedAuthContext(req.authUser.userId, { isActive: false });
      return sendError(res, 403, 'Your account is inactive.');
    }

    req.authUser.role = userRow.role;
    req.authUser.companyId = userRow.company_id ?? req.authUser.companyId ?? null;
    req.authUser.accessRoleId = userRow.access_role_id ?? null;
    req.permissions = await getEffectivePermissions(userRow);

    setCachedAuthContext(req.authUser.userId, {
      isActive: true,
      role: userRow.role,
      companyId: userRow.company_id ?? null,
      accessRoleId: userRow.access_role_id ?? null,
      permissions: req.permissions,
    });
    return next();
  } catch (error) {
    console.error('attachPermissions error:', error);
    return sendError(res, 500, 'Something went wrong while loading permissions.');
  }
}

function requireModulePermission(moduleKey, action, options = {}) {
  const { legacyCompanyAdminBypass = true } = options;
  return (req, res, next) => {
    if (!req.authUser) {
      return sendError(res, 401, 'Authorization token is required.');
    }
    if (req.authUser.role === USER_ROLES.SUPER_ADMIN) {
      return next();
    }
    if (legacyCompanyAdminBypass && req.authUser.role === USER_ROLES.COMPANY_ADMIN) {
      return next();
    }
    if (!hasPermission(req.permissions, moduleKey, action)) {
      const label = String(moduleKey || 'module').replace(/_/g, ' ');
      return sendError(res, 403, `You do not have permission to ${action} ${label}.`);
    }
    return next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== 'super_admin') {
    return sendError(res, 403, 'Only a Super Admin can perform this action.');
  }
  next();
}

function requireCompanyAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== 'company_admin') {
    return sendError(res, 403, 'Only a Company Admin can perform this action.');
  }
  next();
}

/** Sets req.authUser when a valid Bearer token is sent; continues without auth otherwise. */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return next();
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded.userId || !decoded.email) {
      return sendError(res, 401, 'Invalid token payload.');
    }
    req.authUser = decoded;
    next();
  } catch {
    return sendError(res, 401, 'Invalid or expired token.');
  }
}

module.exports = {
  requireAuth,
  attachPermissions,
  requirePermission: requireModulePermission,
  requireModulePermission,
  optionalAuth,
  requireSuperAdmin,
  requireCompanyAdmin,
};
