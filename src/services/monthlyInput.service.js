const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta, parseBooleanQuery } = require('./pagination.service');

const VALID_STATUSES = new Set(['draft', 'pending', 'approved', 'finalized']);
const VALID_ACTIONS = new Set(['post', 'approve', 'finalize', 'return']);

/** action → allowed from statuses → target status */
const TRANSITIONS = {
  post: { from: new Set(['draft']), to: 'pending' },
  approve: { from: new Set(['pending']), to: 'approved' },
  finalize: { from: new Set(['approved']), to: 'finalized' },
  return: { from: new Set(['pending', 'approved', 'finalized']), to: 'draft' },
};

const SELECT_COLUMNS = `mi.id, mi.company_id, mi.employee_id, mi.payroll_schedule_id, mi.is_off_cycle,
  mi.pay_element_id, mi.pay_element_label, mi.amount, mi.pay_date, mi.period_month, mi.status,
  mi.consumed_by_run_id, mi.created_by, mi.created_at, mi.updated_at`;

const RETURNING_COLUMNS = `id, company_id, employee_id, payroll_schedule_id, is_off_cycle,
  pay_element_id, pay_element_label, amount, pay_date, period_month, status,
  consumed_by_run_id, created_by, created_at, updated_at`;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseIdList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: [400, 'ids must be a non-empty array of positive integers.'] };
  }
  const ids = [];
  for (const item of raw) {
    const id = parsePositiveInt(item);
    if (!id) return { error: [400, 'Each id must be a positive integer.'] };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
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

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    employee_code: row.employee_code || undefined,
    employee_name: row.employee_name || undefined,
    employee_email: row.employee_email ?? null,
    payroll_schedule_id: Number(row.payroll_schedule_id),
    schedule_name: row.schedule_name || undefined,
    is_off_cycle: Boolean(row.is_off_cycle),
    pay_element_id: row.pay_element_id != null ? Number(row.pay_element_id) : null,
    pay_element_label: row.pay_element_label,
    amount: parseFloat(row.amount),
    pay_date: row.pay_date,
    period_month: row.period_month,
    status: row.status,
    consumed_by_run_id: row.consumed_by_run_id != null ? Number(row.consumed_by_run_id) : null,
    created_by: row.created_by != null ? Number(row.created_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePeriodMonth(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    return { error: [400, 'period_month must be in YYYY-MM format.'] };
  }
  return { value: raw };
}

function parsePayDate(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: [400, 'pay_date must be in YYYY-MM-DD format.'] };
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return { error: [400, 'pay_date must be a valid calendar date.'] };
  }
  return { value: raw };
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') {
    return { error: [400, 'amount is required and must be a number.'] };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { error: [400, 'amount must be a number.'] };
  }
  return { value: Math.round(n * 100) / 100 };
}

function parseBooleanField(value, fieldName, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue };
  }
  const parsed = parseBooleanQuery(value, defaultValue);
  if (parsed === null) return { error: [400, `${fieldName} must be true or false.`] };
  return { value: parsed };
}

/** Warn when pay_date month differs from period_month (EC9.5). */
function buildPeriodMismatchWarning(periodMonth, payDate) {
  const payMonth = String(payDate).slice(0, 7);
  if (payMonth === periodMonth) return null;
  return `period_month (${periodMonth}) does not match pay_date month (${payMonth}); entry still saved.`;
}

async function resolveSchedule(client, companyId, scheduleId) {
  const result = await client.query(
    `SELECT id, name, payment_day, company_id
     FROM payroll_schedules
     WHERE id = $1 AND company_id = $2`,
    [scheduleId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, 'Payroll schedule not found for your company.'] };
  }
  return { schedule: result.rows[0] };
}

async function resolveEmployee(client, companyId, employeeId) {
  const result = await client.query(
    `SELECT id, first_name, last_name, employee_code
     FROM employees
     WHERE id = $1 AND company_id = $2 AND employment_status != 'exited'`,
    [employeeId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, `Employee id ${employeeId} not found in your company.`] };
  }
  return { employee: result.rows[0] };
}

async function resolvePayElement(client, companyId, payElementId) {
  const result = await client.query(
    `SELECT id, name, payslip_name
     FROM pay_elements
     WHERE id = $1 AND company_id = $2`,
    [payElementId, companyId]
  );
  if (result.rowCount === 0) {
    return { error: [404, `Pay element id ${payElementId} not found in your company.`] };
  }
  return { payElement: result.rows[0] };
}

/**
 * Normalize one create/import entry.
 * Accepts pay_element_id and/or pay_element_label.
 */
async function parseEntryRow(client, companyId, row, { rowIndex = null } = {}) {
  const prefix = rowIndex != null ? `Row ${rowIndex}: ` : '';

  const employeeId = parsePositiveInt(row?.employee_id);
  if (!employeeId) {
    return { error: [400, `${prefix}employee_id must be a positive integer.`] };
  }

  const emp = await resolveEmployee(client, companyId, employeeId);
  if (emp.error) {
    return { error: [emp.error[0], `${prefix}${emp.error[1]}`] };
  }

  const amountParsed = parseAmount(row?.amount);
  if (amountParsed.error) {
    return { error: [amountParsed.error[0], `${prefix}${amountParsed.error[1]}`] };
  }

  const payDateParsed = parsePayDate(row?.pay_date);
  if (payDateParsed.error) {
    return { error: [payDateParsed.error[0], `${prefix}${payDateParsed.error[1]}`] };
  }

  let payElementId = null;
  let payElementLabel = String(row?.pay_element_label ?? '').trim();

  if (row?.pay_element_id !== undefined && row?.pay_element_id !== null && row?.pay_element_id !== '') {
    payElementId = parsePositiveInt(row.pay_element_id);
    if (!payElementId) {
      return { error: [400, `${prefix}pay_element_id must be a positive integer.`] };
    }
    const pe = await resolvePayElement(client, companyId, payElementId);
    if (pe.error) {
      return { error: [pe.error[0], `${prefix}${pe.error[1]}`] };
    }
    if (!payElementLabel) {
      payElementLabel = pe.payElement.payslip_name || pe.payElement.name;
    }
  }

  if (!payElementLabel) {
    return {
      error: [400, `${prefix}pay_element_label is required when pay_element_id is not provided.`],
    };
  }
  if (payElementLabel.length > 120) {
    return { error: [400, `${prefix}pay_element_label must be at most 120 characters.`] };
  }

  return {
    entry: {
      employee_id: employeeId,
      pay_element_id: payElementId,
      pay_element_label: payElementLabel,
      amount: amountParsed.value,
      pay_date: payDateParsed.value,
    },
  };
}

async function insertMonthlyInput(client, {
  companyId,
  adminId,
  scheduleId,
  isOffCycle,
  periodMonth,
  entry,
}) {
  const result = await client.query(
    `INSERT INTO monthly_inputs (
       company_id, employee_id, payroll_schedule_id, is_off_cycle,
       pay_element_id, pay_element_label, amount, pay_date, period_month,
       status, created_by, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       'draft', $10, (NOW() AT TIME ZONE 'UTC')
     )
     RETURNING ${RETURNING_COLUMNS}`,
    [
      companyId,
      entry.employee_id,
      scheduleId,
      isOffCycle,
      entry.pay_element_id,
      entry.pay_element_label,
      entry.amount,
      entry.pay_date,
      periodMonth,
      adminId,
    ]
  );
  return mapRow(result.rows[0]);
}

async function create(authUser, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const { admin } = auth;
  const companyId = Number(admin.company_id);

  const scheduleId = parsePositiveInt(body.schedule_id ?? body.payroll_schedule_id);
  if (!scheduleId) {
    return { error: [400, 'schedule_id must be a positive integer.'] };
  }

  const periodParsed = parsePeriodMonth(body.period_month);
  if (periodParsed.error) return periodParsed;

  const offCycle = parseBooleanField(body.is_off_cycle, 'is_off_cycle', false);
  if (offCycle.error) return offCycle;

  const entriesRaw = Array.isArray(body.entries)
    ? body.entries
    : Array.isArray(body.rows)
      ? body.rows
      : null;

  if (!entriesRaw || entriesRaw.length === 0) {
    return { error: [400, 'entries must be a non-empty array.'] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const schedule = await resolveSchedule(client, companyId, scheduleId);
    if (schedule.error) {
      await client.query('ROLLBACK');
      return schedule;
    }

    const created = [];
    const warnings = [];

    for (let i = 0; i < entriesRaw.length; i += 1) {
      const parsed = await parseEntryRow(client, companyId, entriesRaw[i], { rowIndex: i });
      if (parsed.error) {
        await client.query('ROLLBACK');
        return {
          error: [parsed.error[0], parsed.error[1], { row_index: i, errors: [{ row_index: i, reason: parsed.error[1] }] }],
        };
      }

      const warn = buildPeriodMismatchWarning(periodParsed.value, parsed.entry.pay_date);
      if (warn) warnings.push({ row_index: i, warning: warn });

      const row = await insertMonthlyInput(client, {
        companyId,
        adminId: admin.id,
        scheduleId,
        isOffCycle: offCycle.value,
        periodMonth: periodParsed.value,
        entry: parsed.entry,
      });
      created.push(row);
    }

    await client.query('COMMIT');
    return {
      items: created,
      count: created.length,
      ...(warnings.length ? { warning: warnings[0].warning, warnings } : {}),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function bulkCreate(authUser, body = {}) {
  const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.entries) ? body.entries : null;
  if (!rows || rows.length === 0) {
    return { error: [400, 'rows must be a non-empty array.'] };
  }

  // Atomic validation first: fail fast on any bad row with row_index (EC9.6)
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const { admin } = auth;
  const companyId = Number(admin.company_id);

  const scheduleId = parsePositiveInt(body.schedule_id ?? body.payroll_schedule_id);
  if (!scheduleId) {
    return { error: [400, 'schedule_id must be a positive integer.'] };
  }

  const periodParsed = parsePeriodMonth(body.period_month);
  if (periodParsed.error) return periodParsed;

  const offCycle = parseBooleanField(body.is_off_cycle, 'is_off_cycle', false);
  if (offCycle.error) return offCycle;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const schedule = await resolveSchedule(client, companyId, scheduleId);
    if (schedule.error) {
      await client.query('ROLLBACK');
      return schedule;
    }

    const parsedEntries = [];
    const rowErrors = [];
    const warnings = [];

    for (let i = 0; i < rows.length; i += 1) {
      const parsed = await parseEntryRow(client, companyId, rows[i], { rowIndex: i });
      if (parsed.error) {
        rowErrors.push({ row_index: i, reason: parsed.error[1].replace(/^Row \d+:\s*/, '') });
      } else {
        parsedEntries.push(parsed.entry);
        const warn = buildPeriodMismatchWarning(periodParsed.value, parsed.entry.pay_date);
        if (warn) warnings.push({ row_index: i, warning: warn });
      }
    }

    if (rowErrors.length > 0) {
      await client.query('ROLLBACK');
      return {
        error: [
          400,
          `Import rejected: ${rowErrors.length} invalid row(s). No rows were saved.`,
          { errors: rowErrors, valid_count: parsedEntries.length, invalid_count: rowErrors.length },
        ],
      };
    }

    const created = [];
    for (const entry of parsedEntries) {
      const row = await insertMonthlyInput(client, {
        companyId,
        adminId: admin.id,
        scheduleId,
        isOffCycle: offCycle.value,
        periodMonth: periodParsed.value,
        entry,
      });
      created.push(row);
    }

    await client.query('COMMIT');
    return {
      items: created,
      count: created.length,
      ...(warnings.length ? { warning: warnings[0].warning, warnings } : {}),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function list(authUser, query = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const companyId = Number(auth.admin.company_id);

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const conditions = ['mi.company_id = $1'];
  const params = [companyId];

  if (query.status !== undefined && query.status !== '') {
    const status = String(query.status).trim().toLowerCase();
    if (!VALID_STATUSES.has(status)) {
      return { error: [400, 'status must be draft, pending, approved, or finalized.'] };
    }
    params.push(status);
    conditions.push(`mi.status = $${params.length}`);
  }

  if (query.schedule_id !== undefined && query.schedule_id !== '') {
    const scheduleId = parsePositiveInt(query.schedule_id);
    if (!scheduleId) return { error: [400, 'schedule_id must be a positive integer.'] };
    params.push(scheduleId);
    conditions.push(`mi.payroll_schedule_id = $${params.length}`);
  }

  if (query.period_month !== undefined && query.period_month !== '') {
    const periodParsed = parsePeriodMonth(query.period_month);
    if (periodParsed.error) return periodParsed;
    params.push(periodParsed.value);
    conditions.push(`mi.period_month = $${params.length}`);
  }

  if (query.is_off_cycle !== undefined && query.is_off_cycle !== '') {
    const off = parseBooleanQuery(query.is_off_cycle, null);
    if (off === null) return { error: [400, 'is_off_cycle must be true or false.'] };
    params.push(off);
    conditions.push(`mi.is_off_cycle = $${params.length}`);
  }

  if (query.employee_id !== undefined && query.employee_id !== '') {
    const employeeId = parsePositiveInt(query.employee_id);
    if (!employeeId) return { error: [400, 'employee_id must be a positive integer.'] };
    params.push(employeeId);
    conditions.push(`mi.employee_id = $${params.length}`);
  }

  if (query.pay_element_id !== undefined && query.pay_element_id !== '') {
    const payElementId = parsePositiveInt(query.pay_element_id);
    if (!payElementId) return { error: [400, 'pay_element_id must be a positive integer.'] };
    params.push(payElementId);
    conditions.push(`mi.pay_element_id = $${params.length}`);
  }

  const unifiedSearch = String(query.search || '').trim();
  const employeeName = String(query.employee_name || query.name || '').trim();
  const employeeEmail = String(query.employee_email || query.email || '').trim();
  const searchTerm = unifiedSearch || employeeName || employeeEmail;
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    const searchIndex = params.length;
    conditions.push(`(
      e.first_name ILIKE $${searchIndex}
      OR e.last_name ILIKE $${searchIndex}
      OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex}
      OR e.work_email ILIKE $${searchIndex}
    )`);
  }

  const whereSql = conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM monthly_inputs mi
     JOIN employees e ON e.id = mi.employee_id
     WHERE ${whereSql}`,
    params
  );
  const total = countResult.rows[0].total;

  let sql = `
    SELECT ${SELECT_COLUMNS},
           e.employee_code,
           e.work_email AS employee_email,
           TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS employee_name,
           ps.name AS schedule_name
    FROM monthly_inputs mi
    JOIN employees e ON e.id = mi.employee_id
    JOIN payroll_schedules ps ON ps.id = mi.payroll_schedule_id
    WHERE ${whereSql}
    ORDER BY mi.updated_at DESC, mi.id DESC
  `;

  if (!listPagination.noPagination) {
    const { limit, offset } = listPagination.pagination;
    params.push(limit, offset);
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const result = await pool.query(sql, params);
  const items = result.rows.map(mapRow);

  if (listPagination.noPagination) {
    return { items, total, pagination: null };
  }

  return {
    items,
    total,
    pagination: buildListPaginationMeta(total, listPagination),
  };
}

async function getById(authUser, id) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const companyId = Number(auth.admin.company_id);
  const inputId = parsePositiveInt(id);
  if (!inputId) return { error: [400, 'id must be a positive integer.'] };

  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS},
            e.employee_code,
            e.work_email AS employee_email,
            TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS employee_name,
            ps.name AS schedule_name
     FROM monthly_inputs mi
     JOIN employees e ON e.id = mi.employee_id
     JOIN payroll_schedules ps ON ps.id = mi.payroll_schedule_id
     WHERE mi.id = $1 AND mi.company_id = $2`,
    [inputId, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Monthly input not found.'] };
  return { item: mapRow(result.rows[0]) };
}

async function update(authUser, id, body = {}) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const companyId = Number(auth.admin.company_id);
  const inputId = parsePositiveInt(id);
  if (!inputId) return { error: [400, 'id must be a positive integer.'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT * FROM monthly_inputs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [inputId, companyId]
    );
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: [404, 'Monthly input not found.'] };
    }

    const current = existing.rows[0];
    if (current.status !== 'draft') {
      await client.query('ROLLBACK');
      return {
        error: [400, 'This entry must be Returned to Draft before editing.'],
      };
    }

    const updates = [];
    const params = [];
    let warnings = null;

    if (body.amount !== undefined) {
      const amountParsed = parseAmount(body.amount);
      if (amountParsed.error) {
        await client.query('ROLLBACK');
        return amountParsed;
      }
      params.push(amountParsed.value);
      updates.push(`amount = $${params.length}`);
    }

    if (body.pay_date !== undefined) {
      const payDateParsed = parsePayDate(body.pay_date);
      if (payDateParsed.error) {
        await client.query('ROLLBACK');
        return payDateParsed;
      }
      params.push(payDateParsed.value);
      updates.push(`pay_date = $${params.length}`);
      const warn = buildPeriodMismatchWarning(current.period_month, payDateParsed.value);
      if (warn) warnings = warn;
    }

    if (body.pay_element_id !== undefined || body.pay_element_label !== undefined) {
      let payElementId = current.pay_element_id != null ? Number(current.pay_element_id) : null;
      let payElementLabel = current.pay_element_label;

      if (body.pay_element_id !== undefined) {
        if (body.pay_element_id === null || body.pay_element_id === '') {
          payElementId = null;
        } else {
          payElementId = parsePositiveInt(body.pay_element_id);
          if (!payElementId) {
            await client.query('ROLLBACK');
            return { error: [400, 'pay_element_id must be a positive integer.'] };
          }
          const pe = await resolvePayElement(client, companyId, payElementId);
          if (pe.error) {
            await client.query('ROLLBACK');
            return pe;
          }
          if (body.pay_element_label === undefined) {
            payElementLabel = pe.payElement.payslip_name || pe.payElement.name;
          }
        }
      }

      if (body.pay_element_label !== undefined) {
        payElementLabel = String(body.pay_element_label ?? '').trim();
        if (!payElementLabel) {
          await client.query('ROLLBACK');
          return { error: [400, 'pay_element_label cannot be empty.'] };
        }
        if (payElementLabel.length > 120) {
          await client.query('ROLLBACK');
          return { error: [400, 'pay_element_label must be at most 120 characters.'] };
        }
      }

      params.push(payElementId);
      updates.push(`pay_element_id = $${params.length}`);
      params.push(payElementLabel);
      updates.push(`pay_element_label = $${params.length}`);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return { error: [400, 'No editable fields provided.'] };
    }

    updates.push(`updated_at = (NOW() AT TIME ZONE 'UTC')`);
    params.push(inputId, companyId);

    const result = await client.query(
      `UPDATE monthly_inputs
       SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND company_id = $${params.length}
       RETURNING ${RETURNING_COLUMNS}`,
      params
    );

    await client.query('COMMIT');
    return {
      item: mapRow(result.rows[0]),
      ...(warnings ? { warning: warnings } : {}),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function transition(authUser, idsRaw, actionRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const companyId = Number(auth.admin.company_id);

  const action = String(actionRaw ?? '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return { error: [400, 'action must be one of: post, approve, finalize, return.'] };
  }

  const idsParsed = parseIdList(idsRaw);
  if (idsParsed.error) return idsParsed;
  const { ids } = idsParsed;

  const rule = TRANSITIONS[action];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT id, status, consumed_by_run_id
       FROM monthly_inputs
       WHERE company_id = $1 AND id = ANY($2::bigint[])
       FOR UPDATE`,
      [companyId, ids]
    );

    if (found.rowCount !== ids.length) {
      const foundIds = new Set(found.rows.map((r) => Number(r.id)));
      const missing = ids.filter((id) => !foundIds.has(id));
      await client.query('ROLLBACK');
      return {
        error: [404, `Monthly input id(s) not found: ${missing.join(', ')}.`],
      };
    }

    for (const row of found.rows) {
      if (!rule.from.has(row.status)) {
        await client.query('ROLLBACK');
        return {
          error: [
            400,
            `Cannot move from ${row.status} via "${action}". Allowed from: ${[...rule.from].join(', ')}.`,
          ],
        };
      }

      if (action === 'return' && row.consumed_by_run_id != null) {
        await client.query('ROLLBACK');
        return {
          error: [
            400,
            'This input has already been consumed by a payroll run and cannot be returned.',
          ],
        };
      }
    }

    const updated = await client.query(
      `UPDATE monthly_inputs
       SET status = $1, updated_at = (NOW() AT TIME ZONE 'UTC')
       WHERE company_id = $2 AND id = ANY($3::bigint[])
       RETURNING ${RETURNING_COLUMNS}`,
      [rule.to, companyId, ids]
    );

    await client.query('COMMIT');
    return {
      items: updated.rows.map(mapRow),
      count: updated.rowCount,
      action,
      status: rule.to,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function remove(authUser, idsRaw) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return auth;
  const companyId = Number(auth.admin.company_id);

  const idsParsed = parseIdList(idsRaw);
  if (idsParsed.error) return idsParsed;
  const { ids } = idsParsed;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT id, status, consumed_by_run_id
       FROM monthly_inputs
       WHERE company_id = $1 AND id = ANY($2::bigint[])
       FOR UPDATE`,
      [companyId, ids]
    );

    if (found.rowCount !== ids.length) {
      const foundIds = new Set(found.rows.map((r) => Number(r.id)));
      const missing = ids.filter((id) => !foundIds.has(id));
      await client.query('ROLLBACK');
      return {
        error: [404, `Monthly input id(s) not found: ${missing.join(', ')}.`],
      };
    }

    for (const row of found.rows) {
      if (row.consumed_by_run_id != null) {
        await client.query('ROLLBACK');
        return {
          error: [400, 'Cannot delete a monthly input that has been consumed by a payroll run.'],
        };
      }
      if (row.status !== 'draft') {
        await client.query('ROLLBACK');
        return {
          error: [400, 'Only draft monthly inputs can be deleted. Return to Draft first.'],
        };
      }
    }

    const deleted = await client.query(
      `DELETE FROM monthly_inputs
       WHERE company_id = $1 AND id = ANY($2::bigint[])
       RETURNING id`,
      [companyId, ids]
    );

    await client.query('COMMIT');
    return {
      deleted_ids: deleted.rows.map((r) => Number(r.id)),
      count: deleted.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  TRANSITIONS,
  parsePositiveInt,
  getAuthenticatedCompanyAdmin,
  create,
  bulkCreate,
  list,
  getById,
  update,
  transition,
  remove,
};
