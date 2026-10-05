/**
 * Catalog of permissionable modules shown in Roles & Permissions.
 * Matches Company Admin sidebar + Company Setup tiles.
 * `uploads` is intentionally excluded (universal public upload API).
 */
const SYSTEM_MODULES_SEED = [
  // ── Main modules (sidebar) ──────────────────────────────────────────────
  { module_key: 'hr_dashboard', label: 'Dashboard', category: 'Main Modules', sort_order: 10 },
  { module_key: 'employees', label: 'Employees', category: 'Main Modules', sort_order: 20 },
  { module_key: 'access_roles', label: 'Roles & Permissions', category: 'Main Modules', sort_order: 30 },
  { module_key: 'attendance', label: 'Attendance', category: 'Main Modules', sort_order: 40 },
  { module_key: 'hr_requests', label: 'Requests', category: 'Main Modules', sort_order: 50 },
  { module_key: 'documents', label: 'Documents', category: 'Main Modules', sort_order: 60 },
  { module_key: 'notes', label: 'Notes', category: 'Main Modules', sort_order: 70 },
  { module_key: 'holidays', label: 'Holidays', category: 'Main Modules', sort_order: 80 },

  // Payroll (sidebar children)
  { module_key: 'payroll_schedules', label: 'Payroll Schedule', category: 'Payroll', sort_order: 100 },
  { module_key: 'payroll_allowances', label: 'Allowance', category: 'Payroll', sort_order: 110 },
  { module_key: 'payroll_deductions', label: 'Deduction', category: 'Payroll', sort_order: 120 },
  { module_key: 'payroll_contributions', label: 'Contribution', category: 'Payroll', sort_order: 130 },
  { module_key: 'payroll_salary_templates', label: 'Salary Template', category: 'Payroll', sort_order: 140 },
  { module_key: 'monthly_inputs', label: 'Monthly Inputs', category: 'Payroll', sort_order: 150 },
  { module_key: 'payroll_runs', label: 'Payroll Run', category: 'Payroll', sort_order: 160 },

  // Leave (sidebar children)
  { module_key: 'leave_policies', label: 'Leave Policy', category: 'Leave', sort_order: 200 },
  { module_key: 'leave_balances', label: 'Leave Balance', category: 'Leave', sort_order: 210 },
  { module_key: 'leave_requests', label: 'Leave Requests', category: 'Leave', sort_order: 220 },

  // Performance (sidebar children)
  { module_key: 'performance_competencies', label: 'Competencies', category: 'Performance', sort_order: 230 },
  { module_key: 'performance_templates', label: 'Competency Templates', category: 'Performance', sort_order: 240 },
  { module_key: 'performance_goals', label: 'Goals', category: 'Performance', sort_order: 250 },
  { module_key: 'performance_appraisals', label: 'Appraisals', category: 'Performance', sort_order: 260 },
  { module_key: 'performance_pip', label: 'PIP', category: 'Performance', sort_order: 270 },

  // ── Company Setup tiles ─────────────────────────────────────────────────
  { module_key: 'designations', label: 'Designations', category: 'Company Setup', sort_order: 300 },
  { module_key: 'work_locations', label: 'Work Locations', category: 'Company Setup', sort_order: 310 },
  { module_key: 'departments', label: 'Departments', category: 'Company Setup', sort_order: 320 },
  { module_key: 'org_chart', label: 'Organizational Setup', category: 'Company Setup', sort_order: 325 },
  { module_key: 'shifts', label: 'Shift', category: 'Company Setup', sort_order: 330 },
  { module_key: 'holiday_types', label: 'Holiday Type', category: 'Company Setup', sort_order: 340 },
  { module_key: 'employee_types', label: 'Employee Type', category: 'Company Setup', sort_order: 350 },
  { module_key: 'job_roles', label: 'Employee Role', category: 'Company Setup', sort_order: 360 },
  { module_key: 'document_types', label: 'Document Type', category: 'Company Setup', sort_order: 370 },
  { module_key: 'religions', label: 'Religion', category: 'Company Setup', sort_order: 380 },
  { module_key: 'training', label: 'Training', category: 'Company Setup', sort_order: 390 },

  // Employee portal (needed for Employee access role — not a company-admin sidebar item)
  {
    module_key: 'employee_dashboard',
    label: 'Employee Dashboard',
    category: 'Employee Portal',
    sort_order: 900,
  },
  {
    module_key: 'employee_payslips',
    label: 'My Payslips',
    category: 'Employee Portal',
    sort_order: 910,
  },
  {
    module_key: 'employee_training',
    label: 'Learning',
    category: 'Employee Portal',
    sort_order: 920,
  },
];

const PERMISSION_ACTIONS = ['view', 'add', 'edit', 'delete'];

module.exports = {
  SYSTEM_MODULES_SEED,
  PERMISSION_ACTIONS,
};
