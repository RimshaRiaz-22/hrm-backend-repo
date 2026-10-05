const {
  requireAuth,
  attachPermissions,
  requireModulePermission,
} = require('./auth.middleware');

/**
 * Reusable RBAC middleware chain — same pattern as auth token guards.
 *
 * Usage:
 *   router.get('/items', ...protect('employees', 'view'), controller.list);
 *   router.post('/items', ...protect('employees', 'add'), controller.create);
 *
 * Options are passed to requireModulePermission (e.g. legacyCompanyAdminBypass).
 */
function protect(moduleKey, action, options = {}) {
  return [requireAuth, attachPermissions, requireModulePermission(moduleKey, action, options)];
}

/** Auth + load permissions without requiring a specific module action. */
function withPermissions() {
  return [requireAuth, attachPermissions];
}

module.exports = {
  protect,
  withPermissions,
};
