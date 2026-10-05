const { parseListPagination, buildListPaginationMeta } = require('../pagination.service');
const {
  pool,
  parsePositiveInt,
  parseWeightage,
  assertWeightagesTotal100,
  normalizeStatus,
  validateEmployeesBelongToCompany,
  validateDepartmentBelongsToCompany,
  validateDesignationBelongsToCompany,
  utcNowForPgTimestamp,
  toUtcIsoString,
  parseOptionalDateInput,
} = require('./performance.helpers');

const FREQUENCIES = new Set(['monthly', 'semi_monthly', 'quarterly', 'annually']);

function mapGoal(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    title: row.title,
    description: row.description || null,
    frequency: row.frequency,
    start_date: row.start_date || null,
    end_date: row.end_date || null,
    default_weightage: row.default_weightage != null ? Number(row.default_weightage) : null,
    status: row.status,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function mapAssignment(row) {
  return {
    id: Number(row.id),
    goal_id: Number(row.goal_id),
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_email: row.employee_email || null,
    weightage: Number(row.weightage),
    created_at: toUtcIsoString(row.created_at),
  };
}

function parseGoalFields(body = {}) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'title is required.' };
  if (title.length > 200) return { error: 'title must be at most 200 characters.' };

  const description =
    body.description === undefined || body.description === null
      ? null
      : String(body.description).trim() || null;

  const frequency = String(body.frequency || '').trim().toLowerCase();
  if (!FREQUENCIES.has(frequency)) {
    return { error: 'frequency must be one of: monthly, semi_monthly, quarterly, annually.' };
  }

  let startDate = null;
  let endDate = null;
  if (body.start_date !== undefined && body.start_date !== null && body.start_date !== '') {
    const parsed = parseOptionalDateInput(body.start_date, 'start_date');
    if (parsed.error) return { error: parsed.error };
    startDate = parsed.value;
  }
  if (body.end_date !== undefined && body.end_date !== null && body.end_date !== '') {
    const parsed = parseOptionalDateInput(body.end_date, 'end_date');
    if (parsed.error) return { error: parsed.error };
    endDate = parsed.value;
  }

  let defaultWeightage = null;
  if (body.default_weightage !== undefined && body.default_weightage !== null && body.default_weightage !== '') {
    const w = parseWeightage(body.default_weightage, 'default_weightage');
    if (w.error) return { error: w.error };
    defaultWeightage = w.value;
  } else if (body.weightage !== undefined && body.weightage !== null && body.weightage !== '') {
    const w = parseWeightage(body.weightage, 'weightage');
    if (w.error) return { error: w.error };
    defaultWeightage = w.value;
  }

  const statusResult = normalizeStatus(body.status, 'active');
  if (statusResult.error) return { error: statusResult.error };

  return {
    title,
    description,
    frequency,
    start_date: startDate,
    end_date: endDate,
    default_weightage: defaultWeightage,
    status: statusResult.value,
  };
}

async function createGoal(companyId, body) {
  const fields = parseGoalFields(body);
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `INSERT INTO performance_goals
       (company_id, title, description, frequency, start_date, end_date, default_weightage, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     RETURNING *`,
    [
      companyId,
      fields.title,
      fields.description,
      fields.frequency,
      fields.start_date,
      fields.end_date,
      fields.default_weightage,
      fields.status,
      now,
    ]
  );
  return { goal: mapGoal(result.rows[0]) };
}

async function getGoals(companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId];
  const filters = ['company_id = $1'];
  let idx = 2;

  if (query.status) {
    const statusResult = normalizeStatus(query.status);
    if (statusResult.error) return { error: [400, statusResult.error] };
    filters.push(`status = $${idx++}`);
    values.push(statusResult.value);
  }

  const search = String(query.search || '').trim();
  if (search) {
    filters.push(`(title ILIKE $${idx} OR COALESCE(description, '') ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx += 1;
  }

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM performance_goals WHERE ${whereSql}`,
    values
  );
  const listSql = `SELECT * FROM performance_goals WHERE ${whereSql} ORDER BY created_at DESC, id DESC`;
  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    goals: result.rows.map(mapGoal),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getGoalById(companyId, id) {
  const goalId = parsePositiveInt(id);
  if (!goalId) return { error: [400, 'Invalid goal id.'] };
  const result = await pool.query(
    `SELECT * FROM performance_goals WHERE id = $1 AND company_id = $2`,
    [goalId, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Goal not found.'] };
  const assignments = await pool.query(
    `SELECT ga.*,
            NULLIF(TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))), '') AS employee_name,
            e.work_email AS employee_email
     FROM performance_goal_assignments ga
     JOIN employees e ON e.id = ga.employee_id
     WHERE ga.goal_id = $1 AND ga.company_id = $2
     ORDER BY ga.id ASC`,
    [goalId, companyId]
  );
  return {
    goal: mapGoal(result.rows[0]),
    assignments: assignments.rows.map(mapAssignment),
  };
}

async function updateGoal(companyId, id, body) {
  const existing = await getGoalById(companyId, id);
  if (existing.error) return existing;
  const fields = parseGoalFields({
    ...existing.goal,
    ...body,
    weightage: body.weightage ?? body.default_weightage ?? existing.goal.default_weightage,
  });
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `UPDATE performance_goals
     SET title = $1, description = $2, frequency = $3, start_date = $4, end_date = $5,
         default_weightage = $6, status = $7, updated_at = $8
     WHERE id = $9 AND company_id = $10
     RETURNING *`,
    [
      fields.title,
      fields.description,
      fields.frequency,
      fields.start_date,
      fields.end_date,
      fields.default_weightage,
      fields.status,
      now,
      existing.goal.id,
      companyId,
    ]
  );
  return { goal: mapGoal(result.rows[0]), assignments: existing.assignments };
}

async function deleteGoal(companyId, id) {
  const existing = await getGoalById(companyId, id);
  if (existing.error) return existing;
  await pool.query(`DELETE FROM performance_goals WHERE id = $1 AND company_id = $2`, [
    existing.goal.id,
    companyId,
  ]);
  return { deleted: true, id: existing.goal.id };
}

async function resolveEmployeeIdsForAssignment(companyId, body = {}) {
  const employeeIds = new Set();

  if (Array.isArray(body.employee_ids)) {
    for (const raw of body.employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: 'employee_ids must contain positive integers.' };
      employeeIds.add(id);
    }
  }

  if (body.employee_id !== undefined && body.employee_id !== null && body.employee_id !== '') {
    const id = parsePositiveInt(body.employee_id);
    if (!id) return { error: 'employee_id must be a positive integer.' };
    employeeIds.add(id);
  }

  let departmentId = null;
  let designationId = null;
  if (body.department_id !== undefined && body.department_id !== null && body.department_id !== '') {
    departmentId = parsePositiveInt(body.department_id);
    if (!departmentId) return { error: 'department_id must be a positive integer.' };
    if (!(await validateDepartmentBelongsToCompany(companyId, departmentId))) {
      return { error: 'department_id does not belong to your company.' };
    }
  }
  if (body.designation_id !== undefined && body.designation_id !== null && body.designation_id !== '') {
    designationId = parsePositiveInt(body.designation_id);
    if (!designationId) return { error: 'designation_id must be a positive integer.' };
    if (!(await validateDesignationBelongsToCompany(companyId, designationId))) {
      return { error: 'designation_id does not belong to your company.' };
    }
  }

  if (departmentId || designationId) {
    const result = await pool.query(
      `SELECT e.id
       FROM employees e
       JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE e.company_id = $1
         AND ($2::bigint IS NULL OR ejd.department_id = $2::bigint)
         AND ($3::bigint IS NULL OR ejd.designation_id = $3::bigint)`,
      [companyId, departmentId, designationId]
    );
    result.rows.forEach((r) => employeeIds.add(Number(r.id)));
  }

  const ids = Array.from(employeeIds);
  if (!ids.length) return { error: 'Select at least one employee, department, or designation.' };
  const empCheck = await validateEmployeesBelongToCompany(companyId, ids);
  if (empCheck.error) return { error: empCheck.error };
  return { employeeIds: ids };
}

async function assertEmployeeGoalWeightsOk(client, companyId, employeeId, extraWeight, excludeGoalId = null) {
  const employeeResult = await client.query(
    `SELECT work_email,
            NULLIF(TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))), '') AS employee_name
     FROM employees
     WHERE id = $1 AND company_id = $2`,
    [employeeId, companyId]
  );
  const employee = employeeResult.rows[0];
  const employeeLabel = employee?.work_email
    ? employee.employee_name
      ? `${employee.employee_name} (${employee.work_email})`
      : employee.work_email
    : employee?.employee_name || `Employee #${employeeId}`;

  const result = await client.query(
    `SELECT COALESCE(SUM(weightage), 0)::numeric AS total
     FROM performance_goal_assignments
     WHERE company_id = $1 AND employee_id = $2
       AND ($3::bigint IS NULL OR goal_id <> $3::bigint)`,
    [companyId, employeeId, excludeGoalId]
  );
  const current = Number(result.rows[0].total || 0);
  const next = Math.round((current + Number(extraWeight)) * 100) / 100;
  if (next > 100.01) {
    return {
      error: `${employeeLabel} goal weightages would total ${next}% (max 100%).`,
    };
  }
  return { ok: true, total: next };
}

async function assignGoal(companyId, goalId, body = {}) {
  const goal = await getGoalById(companyId, goalId);
  if (goal.error) return goal;

  const weight =
    body.weightage !== undefined && body.weightage !== null && body.weightage !== ''
      ? parseWeightage(body.weightage)
      : goal.goal.default_weightage != null
        ? { value: goal.goal.default_weightage }
        : { error: 'weightage is required.' };
  if (weight.error) return { error: [400, weight.error] };

  const resolved = await resolveEmployeeIdsForAssignment(companyId, body);
  if (resolved.error) return { error: [400, resolved.error] };

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    const now = utcNowForPgTimestamp();
    for (const employeeId of resolved.employeeIds) {
      const weightCheck = await assertEmployeeGoalWeightsOk(
        client,
        companyId,
        employeeId,
        weight.value,
        goal.goal.id
      );
      if (weightCheck.error) {
        await client.query('ROLLBACK');
        return { error: [400, weightCheck.error] };
      }

      const result = await client.query(
        `INSERT INTO performance_goal_assignments
           (company_id, goal_id, employee_id, weightage, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (goal_id, employee_id)
         DO UPDATE SET weightage = EXCLUDED.weightage, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [companyId, goal.goal.id, employeeId, weight.value, now]
      );
      created.push(mapAssignment(result.rows[0]));
    }

    // Cap at 100% above; exact 100% is enforced when loading participants into an appraisal.
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { assignments: created };
}

async function deleteGoalAssignment(companyId, goalId, assignmentId) {
  const gid = parsePositiveInt(goalId);
  const aid = parsePositiveInt(assignmentId);
  if (!gid || !aid) return { error: [400, 'Invalid id.'] };
  const result = await pool.query(
    `DELETE FROM performance_goal_assignments
     WHERE id = $1 AND goal_id = $2 AND company_id = $3
     RETURNING id`,
    [aid, gid, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Goal assignment not found.'] };
  return { deleted: true, id: aid };
}

async function getEmployeeGoalSummary(companyId, employeeId, excludeGoalId = null) {
  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Invalid employee id.'] };

  const employeeResult = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email
     FROM employees e
     WHERE e.id = $1 AND e.company_id = $2`,
    [id, companyId]
  );
  if (employeeResult.rowCount === 0) return { error: [404, 'Employee not found.'] };
  const employee = employeeResult.rows[0];
  const employeeName =
    `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || `Employee #${id}`;

  const excludeId = excludeGoalId ? parsePositiveInt(excludeGoalId) : null;

  const result = await pool.query(
    `SELECT ga.goal_id, ga.weightage, g.title, g.status AS goal_status
     FROM performance_goal_assignments ga
     JOIN performance_goals g ON g.id = ga.goal_id
     WHERE ga.company_id = $1 AND ga.employee_id = $2
       AND ($3::bigint IS NULL OR ga.goal_id <> $3::bigint)
     ORDER BY ga.id ASC`,
    [companyId, id, excludeId]
  );
  const goals = result.rows.map((row) => ({
    goal_id: Number(row.goal_id),
    title: row.title,
    weightage: Number(row.weightage),
    status: row.goal_status,
  }));
  const totalWeightage = Math.round(goals.reduce((s, g) => s + g.weightage, 0) * 100) / 100;

  return {
    employee: {
      id,
      name: employeeName,
      email: employee.work_email || null,
    },
    goals,
    total_weightage: totalWeightage,
    remaining_weightage: Math.max(0, Math.round((100 - totalWeightage) * 100) / 100),
  };
}

async function getMyGoals(companyId, employeeId) {
  const result = await pool.query(
    `SELECT ga.*, g.title, g.description, g.frequency, g.start_date, g.end_date, g.status AS goal_status
     FROM performance_goal_assignments ga
     JOIN performance_goals g ON g.id = ga.goal_id
     WHERE ga.company_id = $1 AND ga.employee_id = $2
     ORDER BY ga.id ASC`,
    [companyId, employeeId]
  );
  const goals = result.rows.map((row) => ({
    assignment_id: Number(row.id),
    goal_id: Number(row.goal_id),
    title: row.title,
    description: row.description,
    frequency: row.frequency,
    start_date: row.start_date,
    end_date: row.end_date,
    weightage: Number(row.weightage),
    status: row.goal_status,
  }));
  const totalCheck = assertWeightagesTotal100(goals, 'weightage', 'Goal weightages');
  return {
    goals,
    total_weightage: Math.round(goals.reduce((s, g) => s + g.weightage, 0) * 100) / 100,
    weightage_valid: !totalCheck.error,
  };
}

module.exports = {
  createGoal,
  getGoals,
  getGoalById,
  updateGoal,
  deleteGoal,
  assignGoal,
  deleteGoalAssignment,
  getMyGoals,
  getEmployeeGoalSummary,
};
