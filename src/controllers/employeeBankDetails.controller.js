const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { validateAccountNumber, validateIban } = require('../utils/bankValidation');

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function isAdminRole(role) {
  return role === USER_ROLES.COMPANY_ADMIN || role === USER_ROLES.ADMIN || role === USER_ROLES.HR;
}

function isEmployeeRole(role) {
  return role === USER_ROLES.EMPLOYEE || role === USER_ROLES.DEPARTMENT_MANAGER;
}

function normalizeRequiredString(value, field, maxLength) {
  const s = String(value ?? '').trim();
  if (!s) return { error: `${field} is required.` };
  if (s.length > maxLength) return { error: `${field} must be at most ${maxLength} characters.` };
  return { value: s };
}

function normalizeOptionalString(value, field, maxLength) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: null };
  }
  const s = String(value).trim();
  if (s.length > maxLength) return { error: `${field} must be at most ${maxLength} characters.` };
  return { value: s };
}

function serializeId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : String(value);
}

function mapBankRow(row) {
  if (!row) return null;
  return {
    id: serializeId(row.id),
    employee_id: serializeId(row.employee_id),
    bank_name: row.bank_name,
    account_title: row.account_title,
    account_number: row.account_number,
    iban: row.iban ?? null,
    branch_code: row.branch_code ?? null,
    note: row.note ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapBankListRow(row) {
  const bank = mapBankRow(row);
  if (!bank) return null;
  return {
    ...bank,
    employee: {
      id: serializeId(row.employee_id),
      first_name: row.employee_first_name ?? null,
      last_name: row.employee_last_name ?? null,
      work_email: row.work_email ?? null,
      employee_code: row.employee_code ?? null,
    },
  };
}

const bankListFromClause = `FROM employee_bank_details ebd
       INNER JOIN employees e ON e.id = ebd.employee_id`;

const bankListSelect = `SELECT ebd.id,
              ebd.employee_id,
              ebd.bank_name,
              ebd.account_title,
              ebd.account_number,
              ebd.iban,
              ebd.branch_code,
              ebd.note,
              ebd.created_at,
              ebd.updated_at,
              e.first_name AS employee_first_name,
              e.last_name AS employee_last_name,
              e.work_email,
              e.employee_code`;

function validateBankPayload(body, { requireAll = true, allowEmployeeId = false } = {}) {
  const allowed = new Set(['bank_name', 'account_title', 'account_number', 'iban', 'branch_code', 'note']);
  if (allowEmployeeId) allowed.add('employee_id');

  for (const key of Object.keys(body || {})) {
    if (!allowed.has(key)) return { error: `Unknown field "${key}".` };
  }

  const parsed = {};
  const requiredFields = [
    ['bank_name', 100],
    ['account_title', 150],
  ];

  for (const [field, max] of requiredFields) {
    if (requireAll || Object.prototype.hasOwnProperty.call(body, field)) {
      const value = normalizeRequiredString(body[field], field, max);
      if (value.error) return { error: value.error };
      parsed[field] = value.value;
    }
  }

  if (requireAll || Object.prototype.hasOwnProperty.call(body, 'account_number')) {
    const accountNumber = validateAccountNumber(body.account_number, { required: true });
    if (!accountNumber.valid) {
      return { error: accountNumber.error || 'account_number is invalid.' };
    }
    parsed.account_number = accountNumber.value;
  }

  if (requireAll || Object.prototype.hasOwnProperty.call(body, 'iban')) {
    const iban = validateIban(body.iban, { required: false });
    if (!iban.valid) {
      return { error: iban.error || 'iban is invalid.' };
    }
    parsed.iban = iban.value;
  }

  for (const [field, max] of [
    ['branch_code', 20],
    ['note', 500],
  ]) {
    if (requireAll || Object.prototype.hasOwnProperty.call(body, field)) {
      const value = normalizeOptionalString(body[field], field, max);
      if (value.error) return { error: value.error };
      parsed[field] = value.value;
    }
  }

  return { value: parsed };
}

async function resolveActor(authUser) {
  const result = await pool.query(
    `SELECT id, company_id, employee_id, email, role, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [authUser.userId, authUser.email]
  );

  const user = result.rows[0];
  if (!user || user.is_active !== true) {
    return { error: { status: 401, message: 'Authenticated user was not found or is inactive.' } };
  }

  if (isAdminRole(user.role)) {
    return { user, roleType: 'admin' };
  }

  if (isEmployeeRole(user.role)) {
    if (!user.employee_id) {
      return { error: { status: 403, message: 'Employee profile is not linked to this account.' } };
    }
    return { user, roleType: 'employee', employeeId: parsePositiveInt(user.employee_id) };
  }

  return { error: { status: 403, message: 'You are not allowed to manage employee bank details.' } };
}

async function employeeBelongsToCompany(employeeId, companyId) {
  const result = await pool.query(
    `SELECT id, company_id FROM employees WHERE id = $1 AND company_id = $2`,
    [employeeId, companyId]
  );
  return result.rows[0] || null;
}

async function resolveTargetEmployeeId(actor, body = {}) {
  if (actor.roleType === 'employee') {
    return { employeeId: actor.employeeId };
  }

  const employeeId = parsePositiveInt(body.employee_id);
  if (!employeeId) {
    return { error: { status: 400, message: 'employee_id is required and must be a positive integer.' } };
  }

  const employee = await employeeBelongsToCompany(employeeId, actor.user.company_id);
  if (!employee) {
    return { error: { status: 404, message: 'Employee not found for your company.' } };
  }

  return { employeeId };
}

async function canAccessBankDetail(actor, bankId) {
  const result = await pool.query(
    `SELECT ebd.*
     FROM employee_bank_details ebd
     JOIN employees e ON e.id = ebd.employee_id
     WHERE ebd.id = $1
       AND (
         ($2::text = 'admin' AND e.company_id = $3)
         OR ($2::text = 'employee' AND ebd.employee_id = $4)
       )`,
    [
      bankId,
      actor.roleType,
      actor.user.company_id,
      actor.roleType === 'employee' ? actor.employeeId : null,
    ]
  );
  return result.rows[0] || null;
}

async function createEmployeeBankDetails(req, res) {
  const body = req.body || {};
  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);

  const target = await resolveTargetEmployeeId(actor, body);
  if (target.error) return sendError(res, target.error.status, target.error.message);

  const parsed = validateBankPayload(body, { requireAll: true, allowEmployeeId: true });
  if (parsed.error) return sendError(res, 400, parsed.error);

  try {
    const result = await pool.query(
      `INSERT INTO employee_bank_details (
         employee_id, bank_name, account_title, account_number, iban, branch_code, note, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (employee_id)
       DO UPDATE SET
         bank_name = EXCLUDED.bank_name,
         account_title = EXCLUDED.account_title,
         account_number = EXCLUDED.account_number,
         iban = EXCLUDED.iban,
         branch_code = EXCLUDED.branch_code,
         note = EXCLUDED.note,
         updated_at = NOW()
       RETURNING *`,
      [
        target.employeeId,
        parsed.value.bank_name,
        parsed.value.account_title,
        parsed.value.account_number,
        parsed.value.iban,
        parsed.value.branch_code,
        parsed.value.note,
      ]
    );

    return sendSuccess(res, 201, 'Employee bank details saved successfully.', {
      bank_details: mapBankRow(result.rows[0]),
    });
  } catch (error) {
    console.error('createEmployeeBankDetails error:', error);
    return sendError(res, 500, 'Something went wrong while saving employee bank details.');
  }
}

async function getMyEmployeeBankDetails(req, res) {
  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);
  if (actor.roleType !== 'employee') {
    return sendError(res, 403, 'Only employees can use this endpoint.');
  }

  try {
    const result = await pool.query(
      `SELECT * FROM employee_bank_details WHERE employee_id = $1`,
      [actor.employeeId]
    );
    if (result.rowCount === 0) return sendError(res, 404, 'Employee bank details not found.');
    return sendSuccess(res, 200, 'Employee bank details fetched successfully.', {
      bank_details: mapBankRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getMyEmployeeBankDetails error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee bank details.');
  }
}

async function getAllEmployeeBankDetails(req, res) {
  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);

  const actorCompanyId = parsePositiveInt(actor.user.company_id);
  const companyId = parsePositiveInt(req.query?.company_id) || actorCompanyId;
  if (!companyId) {
    return sendError(res, 400, 'company_id query parameter is required and must be a positive integer.');
  }
  if (actorCompanyId && actorCompanyId !== companyId) {
    return sendError(res, 403, 'You can only list bank details for your own company.');
  }

  const employeeIdFilter =
    req.query?.employee_id !== undefined ? parsePositiveInt(req.query.employee_id) : null;
  if (req.query?.employee_id !== undefined && !employeeIdFilter) {
    return sendError(res, 400, 'employee_id must be a positive integer.');
  }

  const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
  const hasSearch = Boolean(search);
  const searchLike = `%${search}%`;
  const listPagination = parseListPagination(req.query);
  if (listPagination.error) return sendError(res, 400, listPagination.error);

  const whereClause = `WHERE e.company_id = $1
         AND ($2::bigint IS NULL OR ebd.employee_id = $2)
         AND (
           $3::text = ''
           OR ebd.bank_name ILIKE $3
           OR ebd.account_title ILIKE $3
           OR ebd.account_number ILIKE $3
           OR COALESCE(ebd.iban, '') ILIKE $3
           OR COALESCE(ebd.branch_code, '') ILIKE $3
           OR COALESCE(ebd.note, '') ILIKE $3
           OR e.first_name ILIKE $3
           OR e.last_name ILIKE $3
           OR COALESCE(e.work_email, '') ILIKE $3
           OR COALESCE(e.employee_code, '') ILIKE $3
         )`;

  const listParams = [companyId, employeeIdFilter, hasSearch ? searchLike : ''];

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       ${bankListFromClause}
       ${whereClause}`,
      listParams
    );

    const result = listPagination.noPagination
      ? await pool.query(
          `${bankListSelect}
       ${bankListFromClause}
       ${whereClause}
       ORDER BY ebd.updated_at DESC, ebd.id DESC`,
          listParams
        )
      : await pool.query(
          `${bankListSelect}
       ${bankListFromClause}
       ${whereClause}
       ORDER BY ebd.updated_at DESC, ebd.id DESC
       LIMIT $4 OFFSET $5`,
          [
            ...listParams,
            listPagination.pagination.limit,
            listPagination.pagination.offset,
          ]
        );

    return sendSuccess(res, 200, 'Employee bank details fetched successfully.', {
      employee_bank_details: result.rows.map(mapBankListRow).filter(Boolean),
      pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    });
  } catch (error) {
    console.error('getAllEmployeeBankDetails error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee bank details.');
  }
}

async function getEmployeeBankDetailsByEmployeeId(req, res) {
  const employeeId = parsePositiveInt(req.params.employee_id);
  if (!employeeId) return sendError(res, 400, 'employee_id must be a positive integer.');

  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);

  if (actor.roleType === 'employee' && actor.employeeId !== employeeId) {
    return sendError(res, 403, 'Employees can only view their own bank details.');
  }

  if (actor.roleType === 'admin') {
    const employee = await employeeBelongsToCompany(employeeId, actor.user.company_id);
    if (!employee) return sendError(res, 404, 'Employee not found for your company.');
  }

  try {
    const result = await pool.query(
      `SELECT * FROM employee_bank_details WHERE employee_id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) return sendError(res, 404, 'Employee bank details not found.');
    return sendSuccess(res, 200, 'Employee bank details fetched successfully.', {
      bank_details: mapBankRow(result.rows[0]),
    });
  } catch (error) {
    console.error('getEmployeeBankDetailsByEmployeeId error:', error);
    return sendError(res, 500, 'Something went wrong while fetching employee bank details.');
  }
}

async function updateEmployeeBankDetails(req, res) {
  const bankId = parsePositiveInt(req.params.id);
  if (!bankId) return sendError(res, 400, 'Bank detail id must be a positive integer.');

  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);

  const existing = await canAccessBankDetail(actor, bankId);
  if (!existing) return sendError(res, 404, 'Employee bank details not found.');

  const parsed = validateBankPayload(req.body || {}, { requireAll: false });
  if (parsed.error) return sendError(res, 400, parsed.error);

  const allowedUpdateFields = ['bank_name', 'account_title', 'account_number', 'iban', 'branch_code', 'note'];
  const updates = [];
  const values = [];
  let idx = 1;

  for (const field of allowedUpdateFields) {
    if (Object.prototype.hasOwnProperty.call(parsed.value, field)) {
      updates.push(`${field} = $${idx++}`);
      values.push(parsed.value[field]);
    }
  }

  if (updates.length === 0) {
    return sendError(res, 400, 'Provide at least one bank detail field to update.');
  }

  values.push(bankId);

  try {
    const result = await pool.query(
      `UPDATE employee_bank_details
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    return sendSuccess(res, 200, 'Employee bank details updated successfully.', {
      bank_details: mapBankRow(result.rows[0]),
    });
  } catch (error) {
    console.error('updateEmployeeBankDetails error:', error);
    return sendError(res, 500, 'Something went wrong while updating employee bank details.');
  }
}

async function deleteEmployeeBankDetails(req, res) {
  const bankId = parsePositiveInt(req.params.id);
  if (!bankId) return sendError(res, 400, 'Bank detail id must be a positive integer.');

  const actor = await resolveActor(req.authUser);
  if (actor.error) return sendError(res, actor.error.status, actor.error.message);

  const existing = await canAccessBankDetail(actor, bankId);
  if (!existing) return sendError(res, 404, 'Employee bank details not found.');

  try {
    const result = await pool.query(
      `DELETE FROM employee_bank_details WHERE id = $1 RETURNING *`,
      [bankId]
    );

    return sendSuccess(res, 200, 'Employee bank details deleted successfully.', {
      id: serializeId(result.rows[0]?.id ?? bankId),
    });
  } catch (error) {
    console.error('deleteEmployeeBankDetails error:', error);
    return sendError(res, 500, 'Something went wrong while deleting employee bank details.');
  }
}

module.exports = {
  createEmployeeBankDetails,
  getAllEmployeeBankDetails,
  getMyEmployeeBankDetails,
  getEmployeeBankDetailsByEmployeeId,
  updateEmployeeBankDetails,
  deleteEmployeeBankDetails,
};
