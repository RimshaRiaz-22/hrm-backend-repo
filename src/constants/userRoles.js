/** Canonical role values stored in `users.role` */
const USER_ROLES = {
  SUPER_ADMIN: 'super_admin',
  COMPANY_ADMIN: 'company_admin',
  DEPARTMENT_MANAGER: 'department_manager',
  EMPLOYEE: 'employee',
  /** Legacy values still accepted if present in DB */
  ADMIN: 'admin',
  HR: 'hr',
  MANAGER: 'manager',
};

const ALL_ROLES = Object.values(USER_ROLES);

module.exports = {
  USER_ROLES,
  ALL_ROLES,
};
