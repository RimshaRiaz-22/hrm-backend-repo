const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');

const PAY_ELEMENT_COLUMNS = `pe.id, pe.company_id, pe.kind, pe.name, pe.payslip_name, pe.category,
  pe.calc_type, pe.calc_value, pe.based_on, pe.is_taxable, pe.is_active`;

const SCHEDULE_COLUMNS = `ps.id, ps.company_id, ps.name, ps.pay_period, ps.start_day, ps.end_day,
  ps.payment_day, ps.holiday_payment_rule, ps.is_default, ps.is_hourly, ps.is_active`;

const TEMPLATE_COLUMNS = `st.id, st.company_id, st.name, st.is_active`;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseCalcType(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'fixed' || s === 'percent_of_basic') return s;
  return null;
}

function parseCalcValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
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

async function fetchActiveEmployee(client, companyId, employeeId) {
  const result = await client.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email, e.employment_status,
            ejd.payroll_schedule_id, ejd.salary_template_id
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.id = $1 AND e.company_id = $2`,
    [employeeId, companyId]
  );
  if (result.rowCount === 0) return null;
  if (result.rows[0].employment_status === 'exited') {
    return { exited: true };
  }
  return result.rows[0];
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

function mapScheduleRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    pay_period: row.pay_period,
    start_day: Number(row.start_day),
    end_day: Number(row.end_day),
    payment_day: Number(row.payment_day),
    holiday_payment_rule: row.holiday_payment_rule,
    is_default: Boolean(row.is_default),
    is_hourly: Boolean(row.is_hourly),
    is_active: Boolean(row.is_active),
  };
}

function mapTemplateRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    is_active: Boolean(row.is_active),
  };
}

function buildResolvedElement(payElement, { source, calc_type, calc_value, template_calc_type, template_calc_value }) {
  const base = mapPayElementRow(payElement);
  return {
    ...base,
    source,
    calc_type,
    calc_value,
    template_calc_type: template_calc_type ?? null,
    template_calc_value: template_calc_value ?? null,
    is_overridden: source === 'override',
    is_manual: source === 'manual',
  };
}

async function fetchTemplateItemIds(client, templateId) {
  if (!templateId) return new Set();
  const result = await client.query(
    `SELECT pay_element_id FROM salary_template_items WHERE salary_template_id = $1`,
    [templateId]
  );
  return new Set(result.rows.map((row) => Number(row.pay_element_id)));
}

async function fetchEmployeePayElementOverrides(client, employeeId) {
  const result = await client.query(
    `SELECT id, pay_element_id, override_calc_type, override_calc_value
     FROM employee_pay_elements
     WHERE employee_id = $1`,
    [employeeId]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.pay_element_id), {
      id: Number(row.id),
      override_calc_type: row.override_calc_type,
      override_calc_value: row.override_calc_value != null ? parseFloat(row.override_calc_value) : null,
    });
  }
  return map;
}

async function resolveEmployeeElements(client, companyId, employeeId, templateId) {
  const templateItemIds = await fetchTemplateItemIds(client, templateId);
  const overrides = await fetchEmployeePayElementOverrides(client, employeeId);

  const templateItemsResult = templateId
    ? await client.query(
        `SELECT ${PAY_ELEMENT_COLUMNS}
         FROM salary_template_items sti
         JOIN pay_elements pe ON pe.id = sti.pay_element_id
         JOIN salary_templates st ON st.id = sti.salary_template_id
         WHERE sti.salary_template_id = $1 AND st.company_id = $2
         ORDER BY pe.kind ASC, pe.name ASC`,
        [templateId, companyId]
      )
    : { rows: [] };

  const resolved = [];
  const includedIds = new Set();

  for (const row of templateItemsResult.rows) {
    const payElementId = Number(row.id);
    includedIds.add(payElementId);
    const override = overrides.get(payElementId);

    if (override) {
      resolved.push(
        buildResolvedElement(row, {
          source: 'override',
          calc_type: override.override_calc_type || row.calc_type,
          calc_value:
            override.override_calc_value != null
              ? override.override_calc_value
              : parseFloat(row.calc_value),
          template_calc_type: row.calc_type,
          template_calc_value: parseFloat(row.calc_value),
        })
      );
    } else {
      resolved.push(
        buildResolvedElement(row, {
          source: 'template',
          calc_type: row.calc_type,
          calc_value: parseFloat(row.calc_value),
          template_calc_type: row.calc_type,
          template_calc_value: parseFloat(row.calc_value),
        })
      );
    }
  }

  const manualIds = [...overrides.keys()].filter((id) => !templateItemIds.has(id));
  if (manualIds.length > 0) {
    const manualResult = await client.query(
      `SELECT ${PAY_ELEMENT_COLUMNS}
       FROM pay_elements pe
       WHERE pe.company_id = $1 AND pe.id = ANY($2::bigint[])
       ORDER BY pe.kind ASC, pe.name ASC`,
      [companyId, manualIds]
    );

    for (const row of manualResult.rows) {
      const payElementId = Number(row.id);
      includedIds.add(payElementId);
      const override = overrides.get(payElementId);
      resolved.push(
        buildResolvedElement(row, {
          source: 'manual',
          calc_type: override?.override_calc_type || row.calc_type,
          calc_value:
            override?.override_calc_value != null
              ? override.override_calc_value
              : parseFloat(row.calc_value),
        })
      );
    }
  }

  return { elements: resolved, templateItemIds, overrides, includedIds };
}

async function validateActivePayElement(client, companyId, payElementId) {
  const result = await client.query(
    `SELECT ${PAY_ELEMENT_COLUMNS}
     FROM pay_elements pe
     WHERE pe.id = $1 AND pe.company_id = $2`,
    [payElementId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, 'Pay element not found for your company.'] };
  }
  const row = result.rows[0];
  if (!row.is_active) {
    return { error: [400, 'This element is inactive and cannot be assigned.'] };
  }
  return { payElement: row };
}

async function validateActiveSchedule(client, companyId, scheduleId) {
  const result = await client.query(
    `SELECT ${SCHEDULE_COLUMNS}
     FROM payroll_schedules ps
     WHERE ps.id = $1 AND ps.company_id = $2`,
    [scheduleId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, 'Payroll schedule not found for your company.'] };
  }
  if (!result.rows[0].is_active) {
    return { error: [400, 'This payroll schedule is inactive and cannot be assigned.'] };
  }
  return { schedule: result.rows[0] };
}

async function validateActiveTemplate(client, companyId, templateId) {
  const result = await client.query(
    `SELECT ${TEMPLATE_COLUMNS}
     FROM salary_templates st
     WHERE st.id = $1 AND st.company_id = $2`,
    [templateId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, 'Salary template not found for your company.'] };
  }
  if (!result.rows[0].is_active) {
    return { error: [400, 'This salary template is inactive and cannot be assigned.'] };
  }
  return { template: result.rows[0] };
}

function parseJoiningMonthFilter(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };

  const text = String(raw).trim().toLowerCase();
  if (text === 'this_month') {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    return { value: monthStr };
  }

  if (/^\d{4}-\d{2}$/.test(text)) {
    return { value: text };
  }

  return { error: [400, 'joining_month must be "this_month" or YYYY-MM.'] };
}

function buildJoiningMonthRange(monthStr) {
  const [yearText, monthText] = monthStr.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const start = `${yearText}-${monthText}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${yearText}-${monthText}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

async function resolveBulkEmployeeIds(client, companyId, body = {}) {
  const scope = String(body?.assignment_scope || '').trim().toLowerCase();
  const joiningMonthParsed = parseJoiningMonthFilter(body?.joining_month);
  if (joiningMonthParsed.error) return joiningMonthParsed;

  let employeeIds;

  if (scope === 'all') {
    const result = await client.query(
      `SELECT e.id
       FROM employees e
       WHERE e.company_id = $1 AND e.employment_status != 'exited'`,
      [companyId]
    );
    employeeIds = result.rows.map((row) => Number(row.id));
  } else if (scope === 'department') {
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
    employeeIds = result.rows.map((row) => Number(row.id));
  } else if (scope === 'selected') {
    const raw = body?.employee_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: [400, 'employee_ids must be a non-empty array for selected assignment.'] };
    }

    employeeIds = [...new Set(raw.map((id) => parsePositiveInt(id)).filter(Boolean))];
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
  } else {
    return { error: [400, 'assignment_scope must be selected, department, or all.'] };
  }

  if (joiningMonthParsed.value) {
    const { start, end } = buildJoiningMonthRange(joiningMonthParsed.value);
    const filtered = await client.query(
      `SELECT e.id
       FROM employees e
       INNER JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE e.company_id = $1
         AND e.id = ANY($2::bigint[])
         AND ejd.joining_date IS NOT NULL
         AND ejd.joining_date >= $3::date
         AND ejd.joining_date <= $4::date`,
      [companyId, employeeIds, start, end]
    );
    employeeIds = filtered.rows.map((row) => Number(row.id));
  }

  if (employeeIds.length === 0) {
    return { error: [400, 'No matching employees found for the selected filters.'] };
  }

  return { employeeIds };
}

async function upsertEmployeeJobPayroll(client, companyId, employeeId, fields) {
  const existing = await client.query(
    `SELECT payroll_schedule_id, salary_template_id
     FROM employee_job_details
     WHERE employee_id = $1`,
    [employeeId]
  );

  const current = existing.rows[0];
  const nextSchedule =
    fields.payroll_schedule_id !== undefined
      ? fields.payroll_schedule_id
      : (current?.payroll_schedule_id ?? null);
  const nextTemplate =
    fields.salary_template_id !== undefined
      ? fields.salary_template_id
      : (current?.salary_template_id ?? null);

  if (current) {
    await client.query(
      `UPDATE employee_job_details
       SET payroll_schedule_id = $3,
           salary_template_id = $4,
           updated_at = NOW()
       WHERE employee_id = $1 AND company_id = $2`,
      [employeeId, companyId, nextSchedule, nextTemplate]
    );
    return;
  }

  await client.query(
    `INSERT INTO employee_job_details (employee_id, company_id, payroll_schedule_id, salary_template_id, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [employeeId, companyId, nextSchedule, nextTemplate]
  );
}

async function getProfile(authUser, employeeId) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Employee id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    const employee = await fetchActiveEmployee(client, companyId, id);
    if (!employee) return { error: [404, 'Employee not found.'] };
    if (employee.exited) return { error: [400, 'Cannot view payroll for an exited employee.'] };

    let schedule = null;
    if (employee.payroll_schedule_id) {
      const scheduleResult = await client.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM payroll_schedules ps WHERE ps.id = $1 AND ps.company_id = $2`,
        [employee.payroll_schedule_id, companyId]
      );
      schedule = mapScheduleRow(scheduleResult.rows[0]);
    }

    let template = null;
    if (employee.salary_template_id) {
      const templateResult = await client.query(
        `SELECT ${TEMPLATE_COLUMNS} FROM salary_templates st WHERE st.id = $1 AND st.company_id = $2`,
        [employee.salary_template_id, companyId]
      );
      template = mapTemplateRow(templateResult.rows[0]);
    }

    const { elements } = await resolveEmployeeElements(
      client,
      companyId,
      id,
      employee.salary_template_id ? Number(employee.salary_template_id) : null
    );

    const grouped = { allowances: [], deductions: [], contributions: [] };
    for (const item of elements) {
      if (item.kind === 'allowance') grouped.allowances.push(item);
      else if (item.kind === 'deduction') grouped.deductions.push(item);
      else if (item.kind === 'contribution') grouped.contributions.push(item);
    }

    return {
      employee_id: id,
      payroll_schedule: schedule,
      salary_template: template,
      has_schedule: Boolean(schedule),
      elements: grouped,
      all_elements: elements,
    };
  } finally {
    client.release();
  }
}

async function updateProfile(authUser, employeeId, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Employee id must be a positive integer.'] };

  const allowedKeys = new Set(['payroll_schedule_id', 'salary_template_id']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }
  if (Object.keys(body || {}).length === 0) {
    return { error: [400, 'Provide payroll_schedule_id and/or salary_template_id to update.'] };
  }

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const employee = await fetchActiveEmployee(client, companyId, id);
    if (!employee) {
      await client.query('ROLLBACK');
      return { error: [404, 'Employee not found.'] };
    }
    if (employee.exited) {
      await client.query('ROLLBACK');
      return { error: [400, 'Cannot update payroll for an exited employee.'] };
    }

    const updates = {};

    if (body.payroll_schedule_id !== undefined) {
      if (body.payroll_schedule_id === null || body.payroll_schedule_id === '') {
        updates.payroll_schedule_id = null;
      } else {
        const scheduleId = parsePositiveInt(body.payroll_schedule_id);
        if (!scheduleId) {
          await client.query('ROLLBACK');
          return { error: [400, 'payroll_schedule_id must be a positive integer or null.'] };
        }
        const scheduleCheck = await validateActiveSchedule(client, companyId, scheduleId);
        if (scheduleCheck.error) {
          await client.query('ROLLBACK');
          return scheduleCheck;
        }
        updates.payroll_schedule_id = scheduleId;
      }
    }

    if (body.salary_template_id !== undefined) {
      if (body.salary_template_id === null || body.salary_template_id === '') {
        updates.salary_template_id = null;
      } else {
        const templateId = parsePositiveInt(body.salary_template_id);
        if (!templateId) {
          await client.query('ROLLBACK');
          return { error: [400, 'salary_template_id must be a positive integer or null.'] };
        }
        const templateCheck = await validateActiveTemplate(client, companyId, templateId);
        if (templateCheck.error) {
          await client.query('ROLLBACK');
          return templateCheck;
        }
        updates.salary_template_id = templateId;
      }
    }

    await upsertEmployeeJobPayroll(client, companyId, id, updates);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getProfile(authUser, id);
}

async function addElement(authUser, employeeId, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Employee id must be a positive integer.'] };

  const payElementId = parsePositiveInt(body.pay_element_id);
  if (!payElementId) return { error: [400, 'pay_element_id is required and must be a positive integer.'] };

  const calcType = parseCalcType(body.calc_type);
  if (!calcType) return { error: [400, 'calc_type must be fixed or percent_of_basic.'] };

  const calcValue = parseCalcValue(body.calc_value);
  if (calcValue === null) return { error: [400, 'calc_value must be a non-negative number.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const employee = await fetchActiveEmployee(client, companyId, id);
    if (!employee) {
      await client.query('ROLLBACK');
      return { error: [404, 'Employee not found.'] };
    }
    if (employee.exited) {
      await client.query('ROLLBACK');
      return { error: [400, 'Cannot add pay elements for an exited employee.'] };
    }

    const elementCheck = await validateActivePayElement(client, companyId, payElementId);
    if (elementCheck.error) {
      await client.query('ROLLBACK');
      return elementCheck;
    }

    const templateId = employee.salary_template_id ? Number(employee.salary_template_id) : null;
    const templateItemIds = await fetchTemplateItemIds(client, templateId);

    if (templateItemIds.has(payElementId)) {
      await client.query('ROLLBACK');
      return {
        error: [
          400,
          'This pay element is already included via the salary template. Use update to override its value.',
        ],
      };
    }

    const existingOverride = await client.query(
      `SELECT id FROM employee_pay_elements WHERE employee_id = $1 AND pay_element_id = $2`,
      [id, payElementId]
    );
    if (existingOverride.rowCount > 0) {
      await client.query('ROLLBACK');
      return { error: [409, 'This pay element is already assigned to the employee.'] };
    }

    await client.query(
      `INSERT INTO employee_pay_elements (company_id, employee_id, pay_element_id, override_calc_type, override_calc_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, id, payElementId, calcType, calcValue]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getProfile(authUser, id);
}

async function updateElement(authUser, employeeId, payElementId, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Employee id must be a positive integer.'] };

  const elementId = parsePositiveInt(payElementId);
  if (!elementId) return { error: [400, 'Pay element id must be a positive integer.'] };

  const calcType = parseCalcType(body.calc_type);
  if (!calcType) return { error: [400, 'calc_type must be fixed or percent_of_basic.'] };

  const calcValue = parseCalcValue(body.calc_value);
  if (calcValue === null) return { error: [400, 'calc_value must be a non-negative number.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const employee = await fetchActiveEmployee(client, companyId, id);
    if (!employee) {
      await client.query('ROLLBACK');
      return { error: [404, 'Employee not found.'] };
    }
    if (employee.exited) {
      await client.query('ROLLBACK');
      return { error: [400, 'Cannot update pay elements for an exited employee.'] };
    }

    const elementCheck = await validateActivePayElement(client, companyId, elementId);
    if (elementCheck.error) {
      await client.query('ROLLBACK');
      return elementCheck;
    }

    const templateId = employee.salary_template_id ? Number(employee.salary_template_id) : null;
    const templateItemIds = await fetchTemplateItemIds(client, templateId);
    const isFromTemplate = templateItemIds.has(elementId);

    const existing = await client.query(
      `SELECT id FROM employee_pay_elements WHERE employee_id = $1 AND pay_element_id = $2`,
      [id, elementId]
    );

    if (!isFromTemplate && existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Pay element is not assigned to this employee. Add it first.'] };
    }

    await client.query(
      `INSERT INTO employee_pay_elements (company_id, employee_id, pay_element_id, override_calc_type, override_calc_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employee_id, pay_element_id) DO UPDATE
         SET override_calc_type = EXCLUDED.override_calc_type,
             override_calc_value = EXCLUDED.override_calc_value`,
      [companyId, id, elementId, calcType, calcValue]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getProfile(authUser, id);
}

async function removeElement(authUser, employeeId, payElementId) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Employee id must be a positive integer.'] };

  const elementId = parsePositiveInt(payElementId);
  if (!elementId) return { error: [400, 'Pay element id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const employee = await fetchActiveEmployee(client, companyId, id);
    if (!employee) {
      await client.query('ROLLBACK');
      return { error: [404, 'Employee not found.'] };
    }
    if (employee.exited) {
      await client.query('ROLLBACK');
      return { error: [400, 'Cannot remove pay elements for an exited employee.'] };
    }

    const templateId = employee.salary_template_id ? Number(employee.salary_template_id) : null;
    const templateItemIds = await fetchTemplateItemIds(client, templateId);
    const isFromTemplate = templateItemIds.has(elementId);

    const deleted = await client.query(
      `DELETE FROM employee_pay_elements
       WHERE employee_id = $1 AND pay_element_id = $2
       RETURNING id`,
      [id, elementId]
    );

    if (deleted.rowCount === 0) {
      if (isFromTemplate) {
        await client.query('ROLLBACK');
        return {
          error: [
            400,
            'This element comes from the salary template and has no override to remove.',
          ],
        };
      }
      await client.query('ROLLBACK');
      return { error: [404, 'Pay element assignment not found for this employee.'] };
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getProfile(authUser, id);
}

async function bulkAssign(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const hasSchedule =
    body.payroll_schedule_id !== undefined &&
    body.payroll_schedule_id !== null &&
    body.payroll_schedule_id !== '';
  const hasTemplate =
    body.salary_template_id !== undefined &&
    body.salary_template_id !== null &&
    body.salary_template_id !== '';

  if (!hasSchedule && !hasTemplate) {
    return {
      error: [400, 'Provide at least one of payroll_schedule_id or salary_template_id.'],
    };
  }

  const companyId = Number(auth.admin.company_id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resolved = await resolveBulkEmployeeIds(client, companyId, body);
    if (resolved.error) {
      await client.query('ROLLBACK');
      return resolved;
    }

    const updates = {};

    if (hasSchedule) {
      const scheduleId = parsePositiveInt(body.payroll_schedule_id);
      if (!scheduleId) {
        await client.query('ROLLBACK');
        return { error: [400, 'payroll_schedule_id must be a positive integer.'] };
      }
      const scheduleCheck = await validateActiveSchedule(client, companyId, scheduleId);
      if (scheduleCheck.error) {
        await client.query('ROLLBACK');
        return scheduleCheck;
      }
      updates.payroll_schedule_id = scheduleId;
    }

    if (hasTemplate) {
      const templateId = parsePositiveInt(body.salary_template_id);
      if (!templateId) {
        await client.query('ROLLBACK');
        return { error: [400, 'salary_template_id must be a positive integer.'] };
      }
      const templateCheck = await validateActiveTemplate(client, companyId, templateId);
      if (templateCheck.error) {
        await client.query('ROLLBACK');
        return templateCheck;
      }
      updates.salary_template_id = templateId;
    }

    for (const employeeId of resolved.employeeIds) {
      await upsertEmployeeJobPayroll(client, companyId, employeeId, updates);
    }

    await client.query('COMMIT');

    return {
      assigned_count: resolved.employeeIds.length,
      assigned_employee_ids: resolved.employeeIds,
      payroll_schedule_id: updates.payroll_schedule_id ?? null,
      salary_template_id: updates.salary_template_id ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Returns employees missing a payroll schedule (for payroll run eligibility checks). */
async function getEmployeesWithoutSchedule(companyId, employeeIds = null) {
  const params = [companyId];
  let idFilter = '';
  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    params.push(employeeIds);
    idFilter = ` AND e.id = ANY($2::bigint[])`;
  }

  const result = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email
     FROM employees e
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     WHERE e.company_id = $1
       AND e.employment_status != 'exited'
       AND (ejd.payroll_schedule_id IS NULL)${idFilter}
     ORDER BY e.first_name ASC, e.last_name ASC`,
    params
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    first_name: row.first_name,
    last_name: row.last_name,
    name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    work_email: row.work_email,
    skip_reason: 'No schedule assigned',
  }));
}

module.exports = {
  getProfile,
  updateProfile,
  addElement,
  updateElement,
  removeElement,
  bulkAssign,
  getEmployeesWithoutSchedule,
  getAuthenticatedCompanyAdmin,
  parsePositiveInt,
  resolveEmployeeElements,
};
