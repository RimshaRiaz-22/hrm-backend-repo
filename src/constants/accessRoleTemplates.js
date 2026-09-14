const { SYSTEM_MODULES_SEED, PERMISSION_ACTIONS } = require('./systemModules.seed');

function allModuleKeys() {
  return SYSTEM_MODULES_SEED.map((m) => m.module_key);
}

function buildMatrix(flags) {
  const { view = false, add = false, edit = false, delete: del = false, modules = allModuleKeys() } =
    flags;
  const matrix = {};
  for (const key of modules) {
    matrix[key] = { view, add, edit, delete: del };
  }
  return matrix;
}

/** Default company templates — copied per company on migration / company create. */
const ACCESS_ROLE_TEMPLATES = [
  {
    name: 'Company Admin',
    description: 'Full access to all modules.',
    is_system_template: true,
    legacy_user_roles: ['company_admin'],
    matrix: buildMatrix({ view: true, add: true, edit: true, delete: true }),
  },
  {
    name: 'HR Manager',
    description: 'Broad HR access without delete permissions.',
    is_system_template: true,
    legacy_user_roles: ['admin', 'hr', 'manager'],
    matrix: buildMatrix({ view: true, add: true, edit: true, delete: false }),
  },
  {
    name: 'Department Manager',
    description: 'Team lead with HR review and employee self-service access.',
    is_system_template: true,
    legacy_user_roles: ['department_manager'],
    matrix: {
      ...buildMatrix({
        view: true,
        add: true,
        edit: true,
        delete: false,
        modules: [
          'hr_dashboard',
          'employees',
          'attendance',
          'hr_requests',
          'leave_requests',
          'leave_balances',
          'documents',
          'notes',
          'employee_dashboard',
          'employee_payslips',
        ],
      }),
    },
  },
  {
    name: 'Employee',
    description: 'Self-service portal access.',
    is_system_template: true,
    legacy_user_roles: ['employee'],
    matrix: buildMatrix({
      view: true,
      add: true,
      edit: false,
      delete: false,
      modules: [
        'employee_dashboard',
        'attendance',
        'leave_policies',
        'leave_balances',
        'leave_requests',
        'hr_requests',
        'documents',
        'notes',
        'employee_payslips',
        'employee_training',
        'performance_goals',
        'performance_appraisals',
        'performance_pip',
      ],
    }),
  },
];

/** System roles whose permissions must stay fixed — every company relies on these existing as-defined. */
const PERMISSION_LOCKED_ROLE_NAMES = ['Company Admin', 'HR Manager'];

function isPermissionsLockedRole(role) {
  return role?.is_system_template === true && PERMISSION_LOCKED_ROLE_NAMES.includes(role?.name);
}

function emptyPermissionsMatrix() {
  return buildMatrix({ view: false, add: false, edit: false, delete: false });
}

function fullPermissionsMatrix() {
  return buildMatrix({ view: true, add: true, edit: true, delete: true });
}

function normalizePermissionMatrix(input) {
  const keys = allModuleKeys();
  const out = {};
  for (const moduleKey of keys) {
    const row = input?.[moduleKey] || {};
    out[moduleKey] = {
      view: row.view === true,
      add: row.add === true,
      edit: row.edit === true,
      delete: row.delete === true,
    };
  }
  return out;
}

function matrixToDbRows(matrix) {
  const rows = [];
  for (const [module_key, flags] of Object.entries(matrix)) {
    rows.push({
      module_key,
      can_view: flags.view === true,
      can_add: flags.add === true,
      can_edit: flags.edit === true,
      can_delete: flags.delete === true,
    });
  }
  return rows;
}

module.exports = {
  ACCESS_ROLE_TEMPLATES,
  PERMISSION_ACTIONS,
  PERMISSION_LOCKED_ROLE_NAMES,
  allModuleKeys,
  emptyPermissionsMatrix,
  fullPermissionsMatrix,
  isPermissionsLockedRole,
  normalizePermissionMatrix,
  matrixToDbRows,
};
