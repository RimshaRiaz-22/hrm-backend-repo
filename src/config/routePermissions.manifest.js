/**
 * Route permission manifest — single source of truth for RBAC enforcement.
 * Each entry: { method, mount, path, moduleKey, action, scope }
 * scope: 'public' | 'company' | 'self'
 *
 * Expand this file until scripts/audit-route-permissions.js reports 100% coverage.
 */
const ROUTE_PERMISSION_MANIFEST = [
  // Departments (enforced)
  { method: 'GET', mount: '/api/v1/departments', path: '/', moduleKey: 'departments', action: 'view', scope: 'company' },
  { method: 'GET', mount: '/api/v1/departments', path: '/summary', moduleKey: 'departments', action: 'view', scope: 'company' },
  { method: 'GET', mount: '/api/v1/departments', path: '/:id', moduleKey: 'departments', action: 'view', scope: 'company' },
  { method: 'POST', mount: '/api/v1/departments', path: '/', moduleKey: 'departments', action: 'add', scope: 'company' },
  { method: 'PATCH', mount: '/api/v1/departments', path: '/:id', moduleKey: 'departments', action: 'edit', scope: 'company' },
  { method: 'PATCH', mount: '/api/v1/departments', path: '/:id/status', moduleKey: 'departments', action: 'edit', scope: 'company' },
  { method: 'DELETE', mount: '/api/v1/departments', path: '/:id', moduleKey: 'departments', action: 'delete', scope: 'company' },

  // Access roles (RBAC admin)
  { method: 'GET', mount: '/api/v1/access-roles', path: '/system-modules', moduleKey: 'access_roles', action: 'view', scope: 'company' },
  { method: 'GET', mount: '/api/v1/access-roles', path: '/', moduleKey: 'access_roles', action: 'view', scope: 'company' },
  { method: 'POST', mount: '/api/v1/access-roles', path: '/', moduleKey: 'access_roles', action: 'add', scope: 'company' },
  { method: 'GET', mount: '/api/v1/access-roles', path: '/:id', moduleKey: 'access_roles', action: 'view', scope: 'company' },
  { method: 'PATCH', mount: '/api/v1/access-roles', path: '/:id', moduleKey: 'access_roles', action: 'edit', scope: 'company' },
  { method: 'PUT', mount: '/api/v1/access-roles', path: '/:id/permissions', moduleKey: 'access_roles', action: 'edit', scope: 'company' },
  { method: 'DELETE', mount: '/api/v1/access-roles', path: '/:id', moduleKey: 'access_roles', action: 'delete', scope: 'company' },
];

module.exports = {
  ROUTE_PERMISSION_MANIFEST,
};
