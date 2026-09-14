const { parseListPagination, buildListPaginationMeta } = require('../pagination.service');
const {
  pool,
  parsePositiveInt,
  parseWeightage,
  normalizeStatus,
  utcNowForPgTimestamp,
  toUtcIsoString,
  validateEmployeesBelongToCompany,
  validateDepartmentBelongsToCompany,
  validateDesignationBelongsToCompany,
} = require('./performance.helpers');

function mapCompetency(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    description: row.description || null,
    status: row.status,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function mapAssignment(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    competency_id: Number(row.competency_id),
    employee_id: Number(row.employee_id),
    weightage: Number(row.weightage),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function parseCompetencyFields(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name is required.' };
  if (name.length > 120) return { error: 'name must be at most 120 characters.' };
  const description =
    body.description === undefined || body.description === null
      ? null
      : String(body.description).trim() || null;
  const statusResult = normalizeStatus(body.status, 'active');
  if (statusResult.error) return { error: statusResult.error };
  return { name, description, status: statusResult.value };
}

async function createCompetency(companyId, body) {
  const fields = parseCompetencyFields(body);
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();

  const existing = await pool.query(
    `SELECT * FROM performance_competencies
     WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))
     LIMIT 1`,
    [companyId, fields.name]
  );
  if (existing.rowCount > 0) {
    return { competency: mapCompetency(existing.rows[0]), existing: true };
  }

  try {
    const result = await pool.query(
      `INSERT INTO performance_competencies (company_id, name, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [companyId, fields.name, fields.description, fields.status, now]
    );
    return { competency: mapCompetency(result.rows[0]), existing: false };
  } catch (err) {
    if (err.code === '23505') {
      const raced = await pool.query(
        `SELECT * FROM performance_competencies
         WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))
         LIMIT 1`,
        [companyId, fields.name]
      );
      if (raced.rowCount > 0) {
        return { competency: mapCompetency(raced.rows[0]), existing: true };
      }
      return { error: [409, 'A competency with this name already exists.'] };
    }
    throw err;
  }
}

async function getCompetencies(companyId, query = {}) {
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
    filters.push(`(name ILIKE $${idx} OR COALESCE(description, '') ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx += 1;
  }

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM performance_competencies WHERE ${whereSql}`,
    values
  );
  const listSql = `SELECT * FROM performance_competencies WHERE ${whereSql} ORDER BY created_at DESC, id DESC`;
  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    competencies: result.rows.map(mapCompetency),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getCompetencyById(companyId, id) {
  const competencyId = parsePositiveInt(id);
  if (!competencyId) return { error: [400, 'Invalid competency id.'] };
  const result = await pool.query(
    `SELECT * FROM performance_competencies WHERE id = $1 AND company_id = $2`,
    [competencyId, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Competency not found.'] };
  return { competency: mapCompetency(result.rows[0]) };
}

async function updateCompetency(companyId, id, body) {
  const existing = await getCompetencyById(companyId, id);
  if (existing.error) return existing;
  const fields = parseCompetencyFields({ ...existing.competency, ...body });
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  try {
    const result = await pool.query(
      `UPDATE performance_competencies
       SET name = $1, description = $2, status = $3, updated_at = $4
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [fields.name, fields.description, fields.status, now, existing.competency.id, companyId]
    );
    return { competency: mapCompetency(result.rows[0]) };
  } catch (err) {
    if (err.code === '23505') return { error: [409, 'A competency with this name already exists.'] };
    throw err;
  }
}

async function deleteCompetency(companyId, id) {
  const existing = await getCompetencyById(companyId, id);
  if (existing.error) return existing;
  try {
    await pool.query(`DELETE FROM performance_competencies WHERE id = $1 AND company_id = $2`, [
      existing.competency.id,
      companyId,
    ]);
    return { deleted: true, id: existing.competency.id };
  } catch (err) {
    if (err.code === '23503') {
      return {
        error: [
          409,
          'This competency is in use (template or assignment) and cannot be deleted. Remove those links first.',
        ],
      };
    }
    throw err;
  }
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

async function assertEmployeeCompetencyWeightsOk(
  client,
  companyId,
  employeeId,
  extraWeight,
  excludeCompetencyId = null
) {
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
     FROM performance_competency_assignments
     WHERE company_id = $1 AND employee_id = $2
       AND ($3::bigint IS NULL OR competency_id <> $3::bigint)`,
    [companyId, employeeId, excludeCompetencyId]
  );
  const current = Number(result.rows[0].total || 0);
  const next = Math.round((current + Number(extraWeight)) * 100) / 100;
  if (next > 100.01) {
    return {
      error: `${employeeLabel} competency weightages would total ${next}% (max 100%).`,
    };
  }
  return { ok: true, total: next };
}

async function assignCompetency(companyId, competencyId, body = {}) {
  const competency = await getCompetencyById(companyId, competencyId);
  if (competency.error) return competency;

  const weight = parseWeightage(body.weightage);
  if (weight.error) return { error: [400, weight.error] };

  const resolved = await resolveEmployeeIdsForAssignment(companyId, body);
  if (resolved.error) return { error: [400, resolved.error] };

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    const now = utcNowForPgTimestamp();
    for (const employeeId of resolved.employeeIds) {
      const weightCheck = await assertEmployeeCompetencyWeightsOk(
        client,
        companyId,
        employeeId,
        weight.value,
        competency.competency.id
      );
      if (weightCheck.error) {
        await client.query('ROLLBACK');
        return { error: [400, weightCheck.error] };
      }

      const result = await client.query(
        `INSERT INTO performance_competency_assignments
           (company_id, competency_id, employee_id, weightage, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (competency_id, employee_id)
         DO UPDATE SET weightage = EXCLUDED.weightage, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [companyId, competency.competency.id, employeeId, weight.value, now]
      );
      created.push(mapAssignment(result.rows[0]));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { assignments: created };
}

async function deleteCompetencyAssignment(companyId, competencyId, assignmentId) {
  const cid = parsePositiveInt(competencyId);
  const aid = parsePositiveInt(assignmentId);
  if (!cid || !aid) return { error: [400, 'Invalid id.'] };
  const result = await pool.query(
    `DELETE FROM performance_competency_assignments
     WHERE id = $1 AND competency_id = $2 AND company_id = $3
     RETURNING id`,
    [aid, cid, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Competency assignment not found.'] };
  return { deleted: true, id: aid };
}

module.exports = {
  createCompetency,
  getCompetencies,
  getCompetencyById,
  updateCompetency,
  deleteCompetency,
  assignCompetency,
  deleteCompetencyAssignment,
  mapCompetency,
};
