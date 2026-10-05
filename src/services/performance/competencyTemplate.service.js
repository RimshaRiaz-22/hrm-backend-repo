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
} = require('./performance.helpers');

function mapTemplate(row) {
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

function mapItem(row) {
  return {
    id: Number(row.id),
    template_id: Number(row.template_id),
    competency_id: Number(row.competency_id),
    competency_name: row.competency_name || row.name || null,
    weightage: Number(row.weightage),
  };
}

function mapAssignment(row) {
  return {
    id: Number(row.id),
    template_id: Number(row.template_id),
    scope_type: row.scope_type,
    department_id: row.department_id != null ? Number(row.department_id) : null,
    designation_id: row.designation_id != null ? Number(row.designation_id) : null,
    employee_id: row.employee_id != null ? Number(row.employee_id) : null,
    created_at: toUtcIsoString(row.created_at),
  };
}

async function fetchTemplate(companyId, id) {
  const templateId = parsePositiveInt(id);
  if (!templateId) return null;
  const result = await pool.query(
    `SELECT * FROM performance_competency_templates WHERE id = $1 AND company_id = $2`,
    [templateId, companyId]
  );
  return result.rows[0] || null;
}

async function fetchTemplateItems(companyId, templateId) {
  const result = await pool.query(
    `SELECT i.*, c.name AS competency_name
     FROM performance_competency_template_items i
     JOIN performance_competencies c ON c.id = i.competency_id
     WHERE i.template_id = $1 AND i.company_id = $2
     ORDER BY i.id ASC`,
    [templateId, companyId]
  );
  return result.rows.map(mapItem);
}

function parseTemplateFields(body = {}) {
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

async function createTemplate(companyId, body) {
  const fields = parseTemplateFields(body);
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  try {
    const result = await pool.query(
      `INSERT INTO performance_competency_templates (company_id, name, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [companyId, fields.name, fields.description, fields.status, now]
    );
    return { template: mapTemplate(result.rows[0]), items: [] };
  } catch (err) {
    if (err.code === '23505') return { error: [409, 'A template with this name already exists.'] };
    throw err;
  }
}

async function getTemplates(companyId, query = {}) {
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
    `SELECT COUNT(*)::int AS total FROM performance_competency_templates WHERE ${whereSql}`,
    values
  );
  const listSql = `SELECT * FROM performance_competency_templates WHERE ${whereSql} ORDER BY created_at DESC, id DESC`;
  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    templates: result.rows.map(mapTemplate),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getTemplateById(companyId, id) {
  const row = await fetchTemplate(companyId, id);
  if (!row) return { error: [404, 'Competency template not found.'] };
  const items = await fetchTemplateItems(companyId, row.id);
  const assignments = await pool.query(
    `SELECT * FROM performance_competency_template_assignments
     WHERE template_id = $1 AND company_id = $2
     ORDER BY id ASC`,
    [row.id, companyId]
  );
  return {
    template: mapTemplate(row),
    items,
    assignments: assignments.rows.map(mapAssignment),
  };
}

async function updateTemplate(companyId, id, body) {
  const existing = await getTemplateById(companyId, id);
  if (existing.error) return existing;
  const fields = parseTemplateFields({ ...existing.template, ...body });
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  try {
    const result = await pool.query(
      `UPDATE performance_competency_templates
       SET name = $1, description = $2, status = $3, updated_at = $4
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [fields.name, fields.description, fields.status, now, existing.template.id, companyId]
    );
    return {
      template: mapTemplate(result.rows[0]),
      items: existing.items,
      assignments: existing.assignments,
    };
  } catch (err) {
    if (err.code === '23505') return { error: [409, 'A template with this name already exists.'] };
    throw err;
  }
}

async function deleteTemplate(companyId, id) {
  const row = await fetchTemplate(companyId, id);
  if (!row) return { error: [404, 'Competency template not found.'] };
  await pool.query(`DELETE FROM performance_competency_templates WHERE id = $1 AND company_id = $2`, [
    row.id,
    companyId,
  ]);
  return { deleted: true, id: Number(row.id) };
}

async function replaceTemplateItems(companyId, id, body = {}) {
  const row = await fetchTemplate(companyId, id);
  if (!row) return { error: [404, 'Competency template not found.'] };

  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) return { error: [400, 'items must be an array.'] };
  if (rawItems.length === 0) return { error: [400, 'Please add at least one competency to the template.'] };

  const parsed = [];
  const seen = new Set();
  for (const item of rawItems) {
    const competencyId = parsePositiveInt(item.competency_id);
    if (!competencyId) return { error: [400, 'Please select a valid competency for each item.'] };
    if (seen.has(competencyId)) return { error: [400, 'Duplicate competencies are not allowed in a template.'] };
    seen.add(competencyId);
    const weight = parseWeightage(item.weightage);
    if (weight.error) return { error: [400, weight.error] };
    parsed.push({ competency_id: competencyId, weightage: weight.value });
  }

  const totalCheck = assertWeightagesTotal100(parsed, 'weightage', 'Competency weightages');
  if (totalCheck.error) return { error: [400, totalCheck.error] };

  const competencyCheck = await pool.query(
    `SELECT id FROM performance_competencies
     WHERE company_id = $1 AND id = ANY($2::bigint[]) AND status = 'active'`,
    [companyId, parsed.map((p) => p.competency_id)]
  );
  if (competencyCheck.rowCount !== parsed.length) {
    return { error: [400, 'One or more competencies are invalid or inactive.'] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM performance_competency_template_items WHERE template_id = $1 AND company_id = $2`,
      [row.id, companyId]
    );
    const now = utcNowForPgTimestamp();
    for (const item of parsed) {
      await client.query(
        `INSERT INTO performance_competency_template_items
           (company_id, template_id, competency_id, weightage, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [companyId, row.id, item.competency_id, item.weightage, now]
      );
    }
    await client.query(
      `UPDATE performance_competency_templates SET updated_at = $1 WHERE id = $2 AND company_id = $3`,
      [now, row.id, companyId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getTemplateById(companyId, row.id);
}

async function createTemplateAssignment(companyId, templateId, body = {}) {
  const row = await fetchTemplate(companyId, templateId);
  if (!row) return { error: [404, 'Competency template not found.'] };

  const scopeType = String(body.scope_type || '').trim().toLowerCase();
  if (!['company', 'department', 'designation', 'employee'].includes(scopeType)) {
    return { error: [400, 'Please choose a valid assignment scope.'] };
  }

  let departmentId = null;
  let designationId = null;
  let employeeId = null;

  if (scopeType === 'department') {
    departmentId = parsePositiveInt(body.department_id);
    if (!departmentId) return { error: [400, 'Please select a department.'] };
    if (!(await validateDepartmentBelongsToCompany(companyId, departmentId))) {
      return { error: [400, 'Selected department does not belong to your company.'] };
    }
  } else if (scopeType === 'designation') {
    designationId = parsePositiveInt(body.designation_id);
    if (!designationId) return { error: [400, 'Please select a designation.'] };
    if (!(await validateDesignationBelongsToCompany(companyId, designationId))) {
      return { error: [400, 'Selected designation does not belong to your company.'] };
    }
  } else if (scopeType === 'employee') {
    employeeId = parsePositiveInt(body.employee_id);
    if (!employeeId) return { error: [400, 'Please select an employee.'] };
    const empCheck = await validateEmployeesBelongToCompany(companyId, [employeeId]);
    if (empCheck.error) return { error: [400, empCheck.error] };
  }

  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `INSERT INTO performance_competency_template_assignments
       (company_id, template_id, scope_type, department_id, designation_id, employee_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING *`,
    [companyId, row.id, scopeType, departmentId, designationId, employeeId, now]
  );
  return { assignment: mapAssignment(result.rows[0]) };
}

async function deleteTemplateAssignment(companyId, templateId, assignmentId) {
  const tid = parsePositiveInt(templateId);
  const aid = parsePositiveInt(assignmentId);
  if (!tid || !aid) return { error: [400, 'Invalid id.'] };
  const result = await pool.query(
    `DELETE FROM performance_competency_template_assignments
     WHERE id = $1 AND template_id = $2 AND company_id = $3
     RETURNING id`,
    [aid, tid, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Assignment not found.'] };
  return { deleted: true, id: aid };
}

module.exports = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  replaceTemplateItems,
  createTemplateAssignment,
  deleteTemplateAssignment,
};
