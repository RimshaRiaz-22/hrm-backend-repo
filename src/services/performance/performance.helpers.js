const pool = require('../../db');
const { USER_ROLES } = require('../../constants/userRoles');
const { utcNowForPgTimestamp, toUtcIsoString, parseOptionalDateInput } = require('../../utils/dateTime');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseWeightage(raw, fieldName = 'weightage') {
  if (raw === undefined || raw === null || raw === '') {
    return { error: `${fieldName} is required.` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    return { error: `${fieldName} must be a number greater than 0 and at most 100.` };
  }
  return { value: Math.round(n * 100) / 100 };
}

function sumWeightages(items, key = 'weightage') {
  return items.reduce((sum, item) => sum + Number(item[key] || 0), 0);
}

function assertWeightagesTotal100(items, key = 'weightage', label = 'Weightages') {
  const total = Math.round(sumWeightages(items, key) * 100) / 100;
  if (Math.abs(total - 100) > 0.01) {
    return { error: `${label} must total 100%. Current total: ${total}%.` };
  }
  return { total };
}

function normalizeStatus(raw, defaultValue = 'active') {
  if (raw === undefined || raw === null || raw === '') return { value: defaultValue };
  const value = String(raw).trim().toLowerCase();
  if (!['active', 'inactive'].includes(value)) {
    return { error: 'status must be one of: active, inactive.' };
  }
  return { value };
}

function getCompanyIdFromAuth(authUser) {
  const id = parsePositiveInt(authUser?.companyId ?? authUser?.company_id);
  return id;
}

async function requireCompanyContext(authUser) {
  if (!authUser?.userId || !authUser?.email) {
    return { error: [401, 'Authentication required.'] };
  }
  const companyId = getCompanyIdFromAuth(authUser);
  if (!companyId) {
    return { error: [403, 'Your account must be linked to a company.'] };
  }
  return { companyId, userId: Number(authUser.userId), role: authUser.role };
}

async function requireEmployeeContext(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id, employee_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };
  const user = result.rows[0];
  if (![USER_ROLES.EMPLOYEE, USER_ROLES.DEPARTMENT_MANAGER].includes(user.role)) {
    return { error: [403, 'Only an employee can access this resource.'] };
  }
  if (!user.is_active || !user.company_id || !user.employee_id) {
    return { error: [403, 'Your account must be active and linked to an employee profile.'] };
  }
  return {
    user,
    employeeId: Number(user.employee_id),
    companyId: Number(user.company_id),
    userId: Number(user.id),
  };
}

async function validateEmployeesBelongToCompany(companyId, employeeIds) {
  if (!employeeIds.length) return { ok: true };
  const result = await pool.query(
    `SELECT id FROM employees WHERE company_id = $1 AND id = ANY($2::bigint[])`,
    [companyId, employeeIds]
  );
  if (result.rowCount !== employeeIds.length) {
    return { error: 'One or more employees do not belong to your company.' };
  }
  return { ok: true };
}

async function validateDepartmentBelongsToCompany(companyId, departmentId) {
  const result = await pool.query(
    `SELECT id FROM departments WHERE id = $1 AND company_id = $2`,
    [departmentId, companyId]
  );
  return result.rowCount > 0;
}

async function validateDesignationBelongsToCompany(companyId, designationId) {
  const result = await pool.query(
    `SELECT id FROM designations WHERE id = $1 AND company_id = $2`,
    [designationId, companyId]
  );
  return result.rowCount > 0;
}

/**
 * Resolve competency template for an employee.
 * Precedence: employee > designation > department > company.
 */
async function resolveTemplateForEmployee(db, companyId, employeeId) {
  const empResult = await db.query(
    `SELECT e.id,
            ejd.department_id,
            ejd.designation_id
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.id = $1 AND e.company_id = $2`,
    [employeeId, companyId]
  );
  if (empResult.rowCount === 0) return null;
  const emp = empResult.rows[0];

  const assignmentResult = await db.query(
    `SELECT a.template_id, a.scope_type, t.name AS template_name
     FROM performance_competency_template_assignments a
     JOIN performance_competency_templates t ON t.id = a.template_id AND t.company_id = a.company_id
     WHERE a.company_id = $1
       AND t.status = 'active'
       AND (
         (a.scope_type = 'employee' AND a.employee_id = $2)
         OR (a.scope_type = 'designation' AND a.designation_id = $3)
         OR (a.scope_type = 'department' AND a.department_id = $4)
         OR (a.scope_type = 'company')
       )
     ORDER BY
       CASE a.scope_type
         WHEN 'employee' THEN 1
         WHEN 'designation' THEN 2
         WHEN 'department' THEN 3
         WHEN 'company' THEN 4
         ELSE 5
       END,
       a.id DESC`,
    [companyId, employeeId, emp.designation_id || null, emp.department_id || null]
  );

  if (assignmentResult.rowCount === 0) return null;
  const templateId = Number(assignmentResult.rows[0].template_id);

  const itemsResult = await db.query(
    `SELECT i.competency_id, i.weightage, c.name, c.description
     FROM performance_competency_template_items i
     JOIN performance_competencies c ON c.id = i.competency_id
     WHERE i.template_id = $1 AND i.company_id = $2 AND c.status = 'active'
     ORDER BY i.id ASC`,
    [templateId, companyId]
  );

  return {
    template_id: templateId,
    template_name: assignmentResult.rows[0].template_name,
    scope_type: assignmentResult.rows[0].scope_type,
    items: itemsResult.rows.map((row) => ({
      competency_id: Number(row.competency_id),
      name: row.name,
      description: row.description,
      weightage: Number(row.weightage),
    })),
  };
}

async function getEmployeeGoalAssignments(db, companyId, employeeId) {
  const result = await db.query(
    `SELECT ga.id AS assignment_id, ga.goal_id, ga.weightage, g.title, g.description, g.frequency, g.start_date, g.end_date
     FROM performance_goal_assignments ga
     JOIN performance_goals g ON g.id = ga.goal_id
     WHERE ga.company_id = $1 AND ga.employee_id = $2 AND g.status = 'active'
     ORDER BY ga.id ASC`,
    [companyId, employeeId]
  );
  return result.rows.map((row) => ({
    assignment_id: Number(row.assignment_id),
    goal_id: Number(row.goal_id),
    title: row.title,
    description: row.description,
    frequency: row.frequency,
    start_date: row.start_date,
    end_date: row.end_date,
    weightage: Number(row.weightage),
  }));
}

async function getEmployeeCompetencyAssignments(db, companyId, employeeId) {
  const result = await db.query(
    `SELECT ca.id AS assignment_id, ca.competency_id, ca.weightage, c.name, c.description
     FROM performance_competency_assignments ca
     JOIN performance_competencies c ON c.id = ca.competency_id
     WHERE ca.company_id = $1 AND ca.employee_id = $2 AND c.status = 'active'
     ORDER BY ca.id ASC`,
    [companyId, employeeId]
  );
  return result.rows.map((row) => ({
    assignment_id: Number(row.assignment_id),
    competency_id: Number(row.competency_id),
    name: row.name,
    description: row.description,
    weightage: Number(row.weightage),
  }));
}

/** If employee has no direct competency assignments, copy once from resolved template. */
async function ensureEmployeeCompetencyAssignments(db, companyId, employeeId) {
  const existing = await getEmployeeCompetencyAssignments(db, companyId, employeeId);
  if (existing.length) return existing;

  const template = await resolveTemplateForEmployee(db, companyId, employeeId);
  if (!template?.items?.length) return [];

  const now = utcNowForPgTimestamp();
  for (const item of template.items) {
    await db.query(
      `INSERT INTO performance_competency_assignments
         (company_id, competency_id, employee_id, weightage, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (competency_id, employee_id) DO NOTHING`,
      [companyId, item.competency_id, employeeId, item.weightage, now]
    );
  }

  return getEmployeeCompetencyAssignments(db, companyId, employeeId);
}

module.exports = {
  pool,
  parsePositiveInt,
  parseWeightage,
  sumWeightages,
  assertWeightagesTotal100,
  normalizeStatus,
  getCompanyIdFromAuth,
  requireCompanyContext,
  requireEmployeeContext,
  validateEmployeesBelongToCompany,
  validateDepartmentBelongsToCompany,
  validateDesignationBelongsToCompany,
  resolveTemplateForEmployee,
  getEmployeeGoalAssignments,
  getEmployeeCompetencyAssignments,
  ensureEmployeeCompetencyAssignments,
  utcNowForPgTimestamp,
  toUtcIsoString,
  parseOptionalDateInput,
};
