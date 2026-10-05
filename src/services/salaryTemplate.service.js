const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta, parseBooleanQuery } = require('./pagination.service');

const TEMPLATE_COLUMNS = `id, company_id, name, is_active, created_at, updated_at`;

const PAY_ELEMENT_COLUMNS = `pe.id, pe.company_id, pe.kind, pe.name, pe.payslip_name, pe.category,
  pe.calc_type, pe.calc_value, pe.based_on, pe.is_taxable, pe.is_active`;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapTemplateRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
    allowance_count: Number(row.allowance_count ?? 0),
    deduction_count: Number(row.deduction_count ?? 0),
    contribution_count: Number(row.contribution_count ?? 0),
    total_items: Number(row.total_items ?? 0),
  };
}

function mapPayElementRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    kind: row.kind,
    name: row.name,
    payslip_name: row.payslip_name,
    category: row.category,
    calc_type: row.calc_type,
    calc_value: parseFloat(row.calc_value),
    based_on: row.based_on,
    is_taxable: Boolean(row.is_taxable),
    is_active: Boolean(row.is_active),
  };
}

function groupItemsByKind(rows) {
  const grouped = {
    allowances: [],
    deductions: [],
    contributions: [],
  };

  for (const row of rows) {
    const item = mapPayElementRow(row);
    if (!item) continue;
    if (item.kind === 'allowance') grouped.allowances.push(item);
    else if (item.kind === 'deduction') grouped.deductions.push(item);
    else if (item.kind === 'contribution') grouped.contributions.push(item);
  }

  return grouped;
}

async function getAuthenticatedCompanyAdmin(authUser) {
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };

  const admin = result.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active || !admin.company_id) {
    return { error: [403, 'Your account must be active and linked to a company.'] };
  }
  return { admin };
}

function parsePayElementIds(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) {
    return { error: [400, 'pay_element_ids must be an array of positive integers.'] };
  }

  const ids = [];
  for (const entry of raw) {
    const id = parsePositiveInt(entry);
    if (!id) {
      return { error: [400, 'Each pay_element_id must be a positive integer.'] };
    }
    ids.push(id);
  }

  return { value: [...new Set(ids)] };
}

function parseName(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) return { error: [400, 'name is required.'] };
    return { value: undefined };
  }
  const name = String(raw).trim();
  if (!name) return { error: [400, 'name cannot be empty.'] };
  if (name.length > 120) return { error: [400, 'name must be at most 120 characters.'] };
  return { value: name };
}

async function validatePayElementIds(client, companyId, payElementIds) {
  if (payElementIds.length === 0) return { value: [] };

  const result = await client.query(
    `SELECT id
     FROM pay_elements
     WHERE company_id = $1 AND id = ANY($2::bigint[])`,
    [companyId, payElementIds]
  );

  if (result.rowCount !== payElementIds.length) {
    return {
      error: [
        400,
        'One or more pay elements are invalid or do not belong to your company.',
      ],
    };
  }

  return { value: payElementIds };
}

async function insertTemplateItems(client, templateId, payElementIds) {
  for (const payElementId of payElementIds) {
    await client.query(
      `INSERT INTO salary_template_items (salary_template_id, pay_element_id)
       VALUES ($1, $2)
       ON CONFLICT (salary_template_id, pay_element_id) DO NOTHING`,
      [templateId, payElementId]
    );
  }
}

async function fetchTemplateById(templateId, companyId) {
  const result = await pool.query(
    `SELECT ${TEMPLATE_COLUMNS},
      (SELECT COUNT(*)::int
       FROM salary_template_items sti
       JOIN pay_elements pe ON pe.id = sti.pay_element_id
       WHERE sti.salary_template_id = salary_templates.id AND pe.kind = 'allowance') AS allowance_count,
      (SELECT COUNT(*)::int
       FROM salary_template_items sti
       JOIN pay_elements pe ON pe.id = sti.pay_element_id
       WHERE sti.salary_template_id = salary_templates.id AND pe.kind = 'deduction') AS deduction_count,
      (SELECT COUNT(*)::int
       FROM salary_template_items sti
       JOIN pay_elements pe ON pe.id = sti.pay_element_id
       WHERE sti.salary_template_id = salary_templates.id AND pe.kind = 'contribution') AS contribution_count,
      (SELECT COUNT(*)::int
       FROM salary_template_items sti
       WHERE sti.salary_template_id = salary_templates.id) AS total_items
     FROM salary_templates
     WHERE id = $1 AND company_id = $2`,
    [templateId, companyId]
  );
  return result.rows[0] || null;
}

async function fetchTemplateItems(templateId, companyId) {
  const result = await pool.query(
    `SELECT ${PAY_ELEMENT_COLUMNS}
     FROM salary_template_items sti
     JOIN pay_elements pe ON pe.id = sti.pay_element_id
     JOIN salary_templates st ON st.id = sti.salary_template_id
     WHERE sti.salary_template_id = $1 AND st.company_id = $2
     ORDER BY pe.kind ASC, pe.name ASC`,
    [templateId, companyId]
  );
  return result.rows;
}

async function countAssignedEmployees(templateId, companyId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM employee_job_details
     WHERE company_id = $1 AND salary_template_id = $2`,
    [companyId, templateId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchAssignedEmployees(templateId, companyId) {
  const result = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email, ejd.department, ejd.department_id
     FROM employee_job_details ejd
     INNER JOIN employees e ON e.id = ejd.employee_id
     WHERE ejd.company_id = $1
       AND ejd.salary_template_id = $2
       AND e.employment_status != 'exited'
     ORDER BY e.first_name ASC, e.last_name ASC`,
    [companyId, templateId]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    first_name: row.first_name,
    last_name: row.last_name,
    name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    work_email: row.work_email,
    department: row.department,
    department_id: row.department_id ? Number(row.department_id) : null,
  }));
}

async function resolveAssignmentEmployeeIds(client, companyId, body) {
  const scope = String(body?.assignment_scope || '').trim().toLowerCase();

  if (scope === 'all') {
    const result = await client.query(
      `SELECT id
       FROM employees
       WHERE company_id = $1 AND employment_status != 'exited'`,
      [companyId]
    );
    const employeeIds = result.rows.map((row) => Number(row.id));
    if (employeeIds.length === 0) {
      return { error: [400, 'No active employees found for this company.'] };
    }
    return { employeeIds };
  }

  if (scope === 'department') {
    const departmentId = parsePositiveInt(body?.department_id);
    if (!departmentId) {
      return { error: [400, 'department_id is required for department assignment.'] };
    }

    const departmentCheck = await client.query(
      `SELECT id FROM departments WHERE id = $1 AND company_id = $2`,
      [departmentId, companyId]
    );
    if (departmentCheck.rowCount === 0) {
      return { error: [400, 'Department not found for your company.'] };
    }

    const result = await client.query(
      `SELECT e.id
       FROM employees e
       INNER JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE e.company_id = $1
         AND e.employment_status != 'exited'
         AND ejd.department_id = $2`,
      [companyId, departmentId]
    );
    const employeeIds = result.rows.map((row) => Number(row.id));
    if (employeeIds.length === 0) {
      return { error: [400, 'No active employees found in the selected department.'] };
    }
    return { employeeIds };
  }

  if (scope === 'selected') {
    const raw = body?.employee_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: [400, 'employee_ids must be a non-empty array for selected assignment.'] };
    }

    const employeeIds = [...new Set(raw.map((id) => parsePositiveInt(id)).filter(Boolean))];
    if (employeeIds.length === 0) {
      return { error: [400, 'employee_ids must contain valid employee ids.'] };
    }

    const check = await client.query(
      `SELECT id
       FROM employees
       WHERE company_id = $1
         AND employment_status != 'exited'
         AND id = ANY($2::bigint[])`,
      [companyId, employeeIds]
    );

    if (check.rowCount !== employeeIds.length) {
      return {
        error: [400, 'One or more selected employees are invalid, exited, or belong to another company.'],
      };
    }

    return { employeeIds };
  }

  return { error: [400, 'assignment_scope must be selected, department, or all.'] };
}

async function assignEmployeesToTemplate(client, companyId, templateId, employeeIds) {
  const insertResult = await client.query(
    `INSERT INTO employee_job_details (employee_id, company_id, salary_template_id, updated_at)
     SELECT e.id, $1, $2, NOW()
     FROM employees e
     WHERE e.company_id = $1
       AND e.id = ANY($3::bigint[])
       AND e.employment_status != 'exited'
     ON CONFLICT (employee_id) DO UPDATE
       SET salary_template_id = EXCLUDED.salary_template_id,
           updated_at = NOW()`,
    [companyId, templateId, employeeIds]
  );

  return insertResult.rowCount;
}

async function assignEmployees(authUser, templateId, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(templateId);
  if (!id) return { error: [400, 'Template id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchTemplateById(id, companyId);
  if (!existing) return { error: [404, 'Salary template not found.'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const resolved = await resolveAssignmentEmployeeIds(client, companyId, body);
    if (resolved.error) {
      await client.query('ROLLBACK');
      return resolved;
    }

    await assignEmployeesToTemplate(client, companyId, id, resolved.employeeIds);

    await client.query('COMMIT');

    const assignedEmployees = await fetchAssignedEmployees(id, companyId);

    return {
      template_id: id,
      assigned_count: resolved.employeeIds.length,
      assigned_employee_ids: resolved.employeeIds,
      assigned_employees: assignedEmployees,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function create(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const nameParsed = parseName(body.name, { required: true });
  if (nameParsed.error) return nameParsed;

  const idsParsed = parsePayElementIds(body.pay_element_ids ?? []);
  if (idsParsed.error) return idsParsed;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ownership = await validatePayElementIds(client, companyId, idsParsed.value);
    if (ownership.error) {
      await client.query('ROLLBACK');
      return ownership;
    }

    const insert = await client.query(
      `INSERT INTO salary_templates (company_id, name, is_active, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       RETURNING ${TEMPLATE_COLUMNS}`,
      [companyId, nameParsed.value]
    );

    const templateId = insert.rows[0].id;
    await insertTemplateItems(client, templateId, idsParsed.value);

    await client.query('COMMIT');

    const template = await fetchTemplateById(templateId, companyId);
    const items = await fetchTemplateItems(templateId, companyId);

    return {
      template: mapTemplateRow(template),
      items: groupItemsByKind(items),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { error: [409, 'A salary template with this name already exists for your company.'] };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function list(authUser, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;

  let isActiveFilter = null;
  if (query?.is_active !== undefined && query?.is_active !== null && query?.is_active !== '') {
    const parsedActive = parseBooleanQuery(query.is_active, true);
    if (parsedActive === null) return { error: [400, 'is_active must be true or false.'] };
    isActiveFilter = parsedActive;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM salary_templates
     WHERE company_id = $1
       AND ($2::text = '' OR name ILIKE $2)
       AND ($3::boolean IS NULL OR is_active = $3)`,
    [companyId, hasSearch ? searchLike : '', isActiveFilter]
  );

  const itemCountSql = `
    (SELECT COUNT(*)::int
     FROM salary_template_items sti
     JOIN pay_elements pe ON pe.id = sti.pay_element_id
     WHERE sti.salary_template_id = st.id AND pe.kind = 'allowance') AS allowance_count,
    (SELECT COUNT(*)::int
     FROM salary_template_items sti
     JOIN pay_elements pe ON pe.id = sti.pay_element_id
     WHERE sti.salary_template_id = st.id AND pe.kind = 'deduction') AS deduction_count,
    (SELECT COUNT(*)::int
     FROM salary_template_items sti
     JOIN pay_elements pe ON pe.id = sti.pay_element_id
     WHERE sti.salary_template_id = st.id AND pe.kind = 'contribution') AS contribution_count,
    (SELECT COUNT(*)::int
     FROM salary_template_items sti
     WHERE sti.salary_template_id = st.id) AS total_items`;

  const result = listPagination.noPagination
    ? await pool.query(
        `SELECT st.id, st.company_id, st.name, st.is_active, st.created_at, st.updated_at,
         ${itemCountSql}
         FROM salary_templates st
         WHERE st.company_id = $1
           AND ($2::text = '' OR st.name ILIKE $2)
           AND ($3::boolean IS NULL OR st.is_active = $3)
         ORDER BY st.created_at DESC`,
        [companyId, hasSearch ? searchLike : '', isActiveFilter]
      )
    : await pool.query(
        `SELECT st.id, st.company_id, st.name, st.is_active, st.created_at, st.updated_at,
         ${itemCountSql}
         FROM salary_templates st
         WHERE st.company_id = $1
           AND ($2::text = '' OR st.name ILIKE $2)
           AND ($3::boolean IS NULL OR st.is_active = $3)
         ORDER BY st.created_at DESC
         LIMIT $4 OFFSET $5`,
        [
          companyId,
          hasSearch ? searchLike : '',
          isActiveFilter,
          listPagination.pagination.limit,
          listPagination.pagination.offset,
        ]
      );

  return {
    templates: result.rows.map(mapTemplateRow),
    pagination: buildListPaginationMeta(countResult.rows[0].total, listPagination),
  };
}

async function get(authUser, id) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const templateId = parsePositiveInt(id);
  if (!templateId) return { error: [400, 'Template id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const template = await fetchTemplateById(templateId, companyId);
  if (!template) return { error: [404, 'Salary template not found.'] };

  const items = await fetchTemplateItems(templateId, companyId);
  const assignedEmployeeCount = await countAssignedEmployees(templateId, companyId);
  const assignedEmployees = await fetchAssignedEmployees(templateId, companyId);

  return {
    template: mapTemplateRow(template),
    items: groupItemsByKind(items),
    assigned_employee_count: assignedEmployeeCount,
    assigned_employees: assignedEmployees,
  };
}

async function update(authUser, id, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const templateId = parsePositiveInt(id);
  if (!templateId) return { error: [400, 'Template id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchTemplateById(templateId, companyId);
  if (!existing) return { error: [404, 'Salary template not found.'] };

  const allowedKeys = new Set(['name', 'is_active', 'pay_element_ids']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }
  if (Object.keys(body || {}).length === 0) {
    return { error: [400, 'Provide at least one field to update.'] };
  }

  let nextName;
  if (body.name !== undefined) {
    const nameParsed = parseName(body.name, { required: true });
    if (nameParsed.error) return nameParsed;
    nextName = nameParsed.value;
  }

  let nextIsActive;
  if (body.is_active !== undefined) {
    const parsed = parseBooleanQuery(body.is_active, true);
    if (parsed === null) return { error: [400, 'is_active must be true or false.'] };
    nextIsActive = parsed;
  }

  let nextPayElementIds;
  if (body.pay_element_ids !== undefined) {
    const idsParsed = parsePayElementIds(body.pay_element_ids);
    if (idsParsed.error) return idsParsed;
    nextPayElementIds = idsParsed.value;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (nextPayElementIds !== undefined) {
      const ownership = await validatePayElementIds(client, companyId, nextPayElementIds);
      if (ownership.error) {
        await client.query('ROLLBACK');
        return ownership;
      }
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (nextName !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(nextName);
    }
    if (nextIsActive !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(nextIsActive);
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      values.push(templateId, companyId);
      await client.query(
        `UPDATE salary_templates
         SET ${updates.join(', ')}
         WHERE id = $${idx++} AND company_id = $${idx}`,
        values
      );
    } else if (nextPayElementIds !== undefined) {
      await client.query(
        `UPDATE salary_templates SET updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [templateId, companyId]
      );
    }

    if (nextPayElementIds !== undefined) {
      await client.query(
        `DELETE FROM salary_template_items WHERE salary_template_id = $1`,
        [templateId]
      );
      await insertTemplateItems(client, templateId, nextPayElementIds);
    }

    await client.query('COMMIT');

    const template = await fetchTemplateById(templateId, companyId);
    const items = await fetchTemplateItems(templateId, companyId);

    return {
      template: mapTemplateRow(template),
      items: groupItemsByKind(items),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { error: [409, 'A salary template with this name already exists for your company.'] };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function remove(authUser, id) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const templateId = parsePositiveInt(id);
  if (!templateId) return { error: [400, 'Template id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchTemplateById(templateId, companyId);
  if (!existing) return { error: [404, 'Salary template not found.'] };

  const assignedEmployeeCount = await countAssignedEmployees(templateId, companyId);

  const deleted = await pool.query(
    `DELETE FROM salary_templates
     WHERE id = $1 AND company_id = $2
     RETURNING ${TEMPLATE_COLUMNS}`,
    [templateId, companyId]
  );

  const result = { template: mapTemplateRow(deleted.rows[0]) };
  if (assignedEmployeeCount > 0) {
    result.warning = `This template was assigned to ${assignedEmployeeCount} employee(s). Their salary template link has been cleared.`;
    result.assigned_employee_count = assignedEmployeeCount;
  }

  return result;
}

module.exports = {
  create,
  list,
  get,
  update,
  remove,
  assignEmployees,
  getAuthenticatedCompanyAdmin,
  parsePositiveInt,
};
