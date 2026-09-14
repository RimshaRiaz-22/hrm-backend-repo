const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseListPagination, buildListPaginationMeta, parseBooleanQuery } = require('./pagination.service');

const PAY_PERIODS = new Set(['monthly', 'bi_weekly']);
const HOLIDAY_PAYMENT_RULES = new Set(['before', 'next_business_day']);

const SCHEDULE_COLUMNS = `id, company_id, name, pay_period, start_day, end_day, payment_day,
  holiday_payment_rule, is_default, is_hourly, is_active, created_at, updated_at`;

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

function parseDayField(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return { error: [400, `${fieldName} is required.`] };
    return { value: undefined };
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    return { error: [400, `${fieldName} must be an integer between 1 and 31.`] };
  }
  return { value: n };
}

function parseBooleanField(value, fieldName, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue };
  }
  const parsed = parseBooleanQuery(value, defaultValue);
  if (parsed === null) return { error: [400, `${fieldName} must be true or false.`] };
  return { value: parsed };
}

function validatePeriodDays(payPeriod, startDay, endDay) {
  if (payPeriod === 'monthly' && endDay < startDay) {
    return { error: [400, 'For monthly schedules, end_day must be greater than or equal to start_day.'] };
  }
  return { ok: true };
}

function parseScheduleInput(body, { isCreate = false } = {}) {
  const errors = [];
  const result = {};

  const nameRaw = body?.name;
  if (isCreate || nameRaw !== undefined) {
    const name = String(nameRaw ?? '').trim();
    if (!name) errors.push('name is required.');
    else if (name.length > 120) errors.push('name must be at most 120 characters.');
    else result.name = name;
  }

  if (isCreate || body?.pay_period !== undefined) {
    const payPeriod = String(body?.pay_period ?? '').trim();
    if (!PAY_PERIODS.has(payPeriod)) {
      errors.push('pay_period must be "monthly" or "bi_weekly".');
    } else {
      result.pay_period = payPeriod;
    }
  }

  const startDay = parseDayField(body?.start_day, 'start_day', { required: isCreate });
  if (startDay.error) return startDay;
  if (startDay.value !== undefined) result.start_day = startDay.value;

  const endDay = parseDayField(body?.end_day, 'end_day', { required: isCreate });
  if (endDay.error) return endDay;
  if (endDay.value !== undefined) result.end_day = endDay.value;

  const paymentDay = parseDayField(body?.payment_day, 'payment_day', { required: isCreate });
  if (paymentDay.error) return paymentDay;
  if (paymentDay.value !== undefined) result.payment_day = paymentDay.value;

  if (isCreate || body?.holiday_payment_rule !== undefined) {
    const rule = String(body?.holiday_payment_rule ?? 'before').trim();
    if (!HOLIDAY_PAYMENT_RULES.has(rule)) {
      errors.push('holiday_payment_rule must be "before" or "next_business_day".');
    } else {
      result.holiday_payment_rule = rule;
    }
  }

  if (isCreate || body?.is_default !== undefined) {
    const isDefault = parseBooleanField(body?.is_default, 'is_default', false);
    if (isDefault.error) return isDefault;
    result.is_default = isDefault.value;
  }

  if (isCreate || body?.is_hourly !== undefined) {
    const isHourly = parseBooleanField(body?.is_hourly, 'is_hourly', false);
    if (isHourly.error) return isHourly;
    result.is_hourly = isHourly.value;
  }

  if (isCreate || body?.is_active !== undefined) {
    const isActive = parseBooleanField(body?.is_active, 'is_active', true);
    if (isActive.error) return isActive;
    result.is_active = isActive.value;
  }

  if (errors.length > 0) {
    return { error: [400, errors[0]] };
  }

  if (result.pay_period && result.start_day !== undefined && result.end_day !== undefined) {
    const periodCheck = validatePeriodDays(result.pay_period, result.start_day, result.end_day);
    if (periodCheck.error) return periodCheck;
  }

  return { value: result };
}

async function fetchScheduleById(scheduleId, companyId) {
  const result = await pool.query(
    `SELECT ${SCHEDULE_COLUMNS}
     FROM payroll_schedules
     WHERE id = $1 AND company_id = $2`,
    [scheduleId, companyId]
  );
  return result.rows[0] || null;
}

async function countEmployeesOnSchedule(scheduleId, companyId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM employee_job_details
     WHERE company_id = $1 AND payroll_schedule_id = $2`,
    [companyId, scheduleId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function unsetCompanyDefault(client, companyId, exceptId = null) {
  if (exceptId) {
    await client.query(
      `UPDATE payroll_schedules
       SET is_default = FALSE, updated_at = NOW()
       WHERE company_id = $1 AND is_default = TRUE AND id <> $2`,
      [companyId, exceptId]
    );
  } else {
    await client.query(
      `UPDATE payroll_schedules
       SET is_default = FALSE, updated_at = NOW()
       WHERE company_id = $1 AND is_default = TRUE`,
      [companyId]
    );
  }
}

async function create(authUser, body) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const companyId = Number(auth.admin.company_id);
  const parsed = parseScheduleInput(body, { isCreate: true });
  if (parsed.error) return parsed;

  const input = parsed.value;
  const periodCheck = validatePeriodDays(input.pay_period, input.start_day, input.end_day);
  if (periodCheck.error) return periodCheck;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (input.is_default) {
      await unsetCompanyDefault(client, companyId);
    }

    const insert = await client.query(
      `INSERT INTO payroll_schedules (
         company_id, name, pay_period, start_day, end_day, payment_day,
         holiday_payment_rule, is_default, is_hourly, is_active, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING ${SCHEDULE_COLUMNS}`,
      [
        companyId,
        input.name,
        input.pay_period,
        input.start_day,
        input.end_day,
        input.payment_day,
        input.holiday_payment_rule,
        input.is_default,
        input.is_hourly,
        input.is_active,
      ]
    );

    await client.query('COMMIT');
    return { schedule: mapScheduleRow(insert.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { error: [409, 'A payroll schedule with this name already exists for this company.'] };
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
     FROM payroll_schedules
     WHERE company_id = $1
       AND ($2::text = '' OR name ILIKE $2)
       AND ($3::boolean IS NULL OR is_active = $3)`,
    [companyId, hasSearch ? searchLike : '', isActiveFilter]
  );

  const result = listPagination.noPagination
    ? await pool.query(
        `SELECT ${SCHEDULE_COLUMNS}
         FROM payroll_schedules
         WHERE company_id = $1
           AND ($2::text = '' OR name ILIKE $2)
           AND ($3::boolean IS NULL OR is_active = $3)
         ORDER BY is_default DESC, name ASC`,
        [companyId, hasSearch ? searchLike : '', isActiveFilter]
      )
    : await pool.query(
        `SELECT ${SCHEDULE_COLUMNS}
         FROM payroll_schedules
         WHERE company_id = $1
           AND ($2::text = '' OR name ILIKE $2)
           AND ($3::boolean IS NULL OR is_active = $3)
         ORDER BY is_default DESC, name ASC
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
    schedules: result.rows.map(mapScheduleRow),
    pagination: buildListPaginationMeta(countResult.rows[0].total, listPagination),
  };
}

async function update(authUser, scheduleId, body) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(scheduleId);
  if (!id) return { error: [400, 'Schedule id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchScheduleById(id, companyId);
  if (!existing) return { error: [404, 'Payroll schedule not found.'] };

  const allowedKeys = new Set([
    'name',
    'pay_period',
    'start_day',
    'end_day',
    'payment_day',
    'holiday_payment_rule',
    'is_default',
    'is_hourly',
    'is_active',
  ]);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { error: [400, `Unknown field "${key}".`] };
  }
  if (Object.keys(body || {}).length === 0) {
    return { error: [400, 'Provide at least one field to update.'] };
  }

  const parsed = parseScheduleInput(body, { isCreate: false });
  if (parsed.error) return parsed;

  const input = parsed.value;
  const merged = {
    pay_period: input.pay_period ?? existing.pay_period,
    start_day: input.start_day ?? Number(existing.start_day),
    end_day: input.end_day ?? Number(existing.end_day),
  };
  const periodCheck = validatePeriodDays(merged.pay_period, merged.start_day, merged.end_day);
  if (periodCheck.error) return periodCheck;

  const updates = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(input)) {
    updates.push(`${key} = $${idx++}`);
    values.push(val);
  }
  updates.push('updated_at = NOW()');
  values.push(id, companyId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (input.is_default === true) {
      await unsetCompanyDefault(client, companyId, id);
    }

    const updated = await client.query(
      `UPDATE payroll_schedules
       SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING ${SCHEDULE_COLUMNS}`,
      values
    );

    await client.query('COMMIT');

    const schedule = mapScheduleRow(updated.rows[0]);
    const response = { schedule };

    if (input.is_active === false) {
      const employeeCount = await countEmployeesOnSchedule(id, companyId);
      if (employeeCount > 0) {
        response.warning = `${employeeCount} employee(s) still reference this schedule.`;
      }
    }

    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { error: [409, 'A payroll schedule with this name already exists for this company.'] };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function countPayrollRunsOnSchedule(scheduleId, companyId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM payroll_runs
     WHERE payroll_schedule_id = $1 AND company_id = $2`,
    [scheduleId, companyId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function remove(authUser, scheduleId) {
  const auth = await getAuthenticatedCompanyAdmin(authUser);
  if (auth.error) return { error: auth.error };

  const id = parsePositiveInt(scheduleId);
  if (!id) return { error: [400, 'Schedule id must be a positive integer.'] };

  const companyId = Number(auth.admin.company_id);
  const existing = await fetchScheduleById(id, companyId);
  if (!existing) return { error: [404, 'Payroll schedule not found.'] };

  const runCount = await countPayrollRunsOnSchedule(id, companyId);
  if (runCount > 0) {
    return {
      error: [409, 'This schedule cannot be deleted because it is linked to one or more payroll runs.'],
    };
  }

  const employeeCount = await countEmployeesOnSchedule(id, companyId);

  try {
    const deleted = await pool.query(
      `DELETE FROM payroll_schedules
       WHERE id = $1 AND company_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [id, companyId]
    );
    if (deleted.rowCount === 0) return { error: [404, 'Payroll schedule not found.'] };

    const response = { schedule: mapScheduleRow(deleted.rows[0]) };
    if (employeeCount > 0) {
      response.warning = `${employeeCount} employee(s) had this schedule assigned; their schedule link has been cleared.`;
    }

    return response;
  } catch (error) {
    if (error?.code === '23503') {
      return {
        error: [409, 'This schedule cannot be deleted because it is referenced by other records.'],
      };
    }
    throw error;
  }
}

module.exports = {
  create,
  list,
  update,
  remove,
  getAuthenticatedCompanyAdmin,
  parsePositiveInt,
};
