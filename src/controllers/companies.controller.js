const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parseOptionalDateInput } = require('../utils/dateTime');
const { parsePagination, buildPaginationMeta } = require('../services/pagination.service');
const { seedCompanyDefaultRoles } = require('../services/accessRoles.service');
const { validateCurrency } = require('../utils/currencyValidation');
const USER_ROW_SQL = `id, company_id, employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
  profile_picture_url, otp_code, otp_expires_at, last_login_at, device_id, signup_type, phone_number,
  mfa_enabled, dob, created_at, updated_at`;

const SALARY_METHODS = new Set(['working_days', 'calendar_days', 'fixed_days']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toBool(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return false;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function resolveScopedCompanyId(adminCompanyId, tokenCompanyId) {
  return parsePositiveInt(adminCompanyId) || parsePositiveInt(tokenCompanyId) || null;
}

function parseBooleanQuery(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function parseCompanyJsonObject(value) {
  if (value === undefined || value === null) {
    return { ok: true, data: {} };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ok: true, data: value };
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return { ok: true, data: {} };
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false };
      }
      return { ok: true, data: parsed };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

function mapCompanyRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    company_email: row.company_email ?? null,
    business_phone_no: row.business_phone_no ?? null,
    type: row.type ?? null,
    logo_url: row.logo_url ?? null,
    cover_url: row.cover_url ?? null,
    website: row.website ?? null,
    currency: row.currency ?? null,
    country: row.country ?? null,
    timezone: row.timezone ?? null,
    salary_method: row.salary_method ?? null,
    national_id_mandatory: row.national_id_mandatory === true,
    mfa_enabled: row.mfa_enabled === true,
    payslip_password_protected: row.payslip_password_protected === true,
    idle_timeout_mins:
      row.idle_timeout_mins !== undefined && row.idle_timeout_mins !== null
        ? Number(row.idle_timeout_mins)
        : null,
    loan_settings: row.loan_settings && typeof row.loan_settings === 'object' ? row.loan_settings : {},
    attendance_settings:
      row.attendance_settings && typeof row.attendance_settings === 'object'
        ? row.attendance_settings
        : {},
    sandwich_rule: row.sandwich_rule === true,
    is_active: row.is_active === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** GET /api/v1/auth/companies — public for employee self-registration */
async function getPublicCompanies(req, res) {
  try {
    const noPagination = parseBooleanQuery(req.query?.no_pagination, false);
    if (noPagination === null) {
      return sendError(res, 400, 'no_pagination must be true or false.');
    }

    const pagination = noPagination ? null : parsePagination(req.query);
    if (!noPagination && pagination.error) {
      return sendError(res, 400, pagination.error);
    }

    const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
    const hasSearch = Boolean(search);
    const searchLike = `%${search}%`;

    const dateRaw = req.query?.date !== undefined ? String(req.query.date).trim() : '';
    let dateVal = dateRaw ? dateRaw : null;
    if (dateVal) {
      const dateParsed = parseOptionalDateInput(dateVal, 'date');
      if (dateParsed.error) {
        return sendError(res, 400, dateParsed.error);
      }
      dateVal = dateParsed.value;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM companies c
       WHERE c.is_active = true
         AND ($3::date IS NULL OR c.created_at::date = $3::date)
         AND (
           $2::text = ''
           OR c.name ILIKE $2
           OR EXISTS (
             SELECT 1
             FROM users su
             WHERE su.company_id = c.id
               AND su.role = $1
               AND su.email ILIKE $2
           )
         )`,
      [USER_ROLES.COMPANY_ADMIN, hasSearch ? searchLike : '', dateVal]
    );

    const result = noPagination
      ? await pool.query(
          `SELECT c.*,
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
                    ORDER BY u.id ASC
                    LIMIT 1
                  ) AS email
           FROM companies c
           WHERE c.is_active = true
             AND ($3::date IS NULL OR c.created_at::date = $3::date)
             AND (
               $2::text = ''
               OR c.name ILIKE $2
               OR EXISTS (
                 SELECT 1
                 FROM users su
                 WHERE su.company_id = c.id
                   AND su.role = $1
                   AND su.email ILIKE $2
               )
             )
           ORDER BY c.name ASC`,
          [USER_ROLES.COMPANY_ADMIN, hasSearch ? searchLike : '', dateVal]
        )
      : await pool.query(
          `SELECT c.*,
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
                    ORDER BY u.id ASC
                    LIMIT 1
                  ) AS email
           FROM companies c
           WHERE c.is_active = true
             AND ($3::date IS NULL OR c.created_at::date = $3::date)
             AND (
               $2::text = ''
               OR c.name ILIKE $2
               OR EXISTS (
                 SELECT 1
                 FROM users su
                 WHERE su.company_id = c.id
                   AND su.role = $1
                   AND su.email ILIKE $2
               )
             )
           ORDER BY c.name ASC
           LIMIT $4 OFFSET $5`,
          [USER_ROLES.COMPANY_ADMIN, hasSearch ? searchLike : '', dateVal, pagination.limit, pagination.offset]
        );

    const totalItems = Number(countResult.rows[0]?.total) || 0;
    const responsePagination = noPagination
      ? buildPaginationMeta(totalItems, 1, totalItems > 0 ? totalItems : 1)
      : buildPaginationMeta(totalItems, pagination.page, pagination.limit);

    return sendSuccess(res, 200, 'Companies fetched successfully.', {
      companies: result.rows.map((row) => ({
        ...mapCompanyRow(row),
        company_admin_email: row.email || null,
      })),
      pagination: responsePagination,
    });
  } catch (error) {
    console.error('getPublicCompanies error:', error);
    return sendError(res, 500, 'Something went wrong while fetching companies.');
  }
}

/** GET /api/v1/companies — company-admin scoped list (all companies owned by logged-in admin) */
async function getCompanies(req, res) {
  try {
    const noPagination = parseBooleanQuery(req.query?.no_pagination, false);
    if (noPagination === null) {
      return sendError(res, 400, 'no_pagination must be true or false.');
    }

    const pagination = noPagination ? null : parsePagination(req.query);
    if (!noPagination && pagination.error) {
      return sendError(res, 400, pagination.error);
    }

    const adminResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );
    if (adminResult.rowCount === 0) {
      return sendError(res, 401, 'Authenticated user not found.');
    }

    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can view companies from this endpoint.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    const search = req.query?.search !== undefined ? String(req.query.search).trim() : '';
    const hasSearch = Boolean(search);
    const searchLike = `%${search}%`;

    const scopedCompanyId = resolveScopedCompanyId(admin.company_id, req.authUser?.companyId);
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM companies c
       WHERE c.is_active = true
         AND (c.super_admin_id = $1 OR ($2::bigint IS NOT NULL AND c.id = $2))
         AND (
           $3::text = ''
           OR c.name ILIKE $3
           OR EXISTS (
             SELECT 1
             FROM users su
             WHERE su.company_id = c.id
               AND su.role = $4
               AND su.email ILIKE $3
           )
         )`,
      [Number(admin.id), scopedCompanyId, hasSearch ? searchLike : '', USER_ROLES.COMPANY_ADMIN]
    );

    const result = noPagination
      ? await pool.query(
          `SELECT c.*,
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
                    ORDER BY u.id ASC
                    LIMIT 1
                  ) AS email
           FROM companies c
           WHERE c.is_active = true
             AND (c.super_admin_id = $2 OR ($3::bigint IS NOT NULL AND c.id = $3))
             AND (
               $4::text = ''
               OR c.name ILIKE $4
               OR EXISTS (
                 SELECT 1
                 FROM users su
                 WHERE su.company_id = c.id
                   AND su.role = $1
                   AND su.email ILIKE $4
               )
             )
           ORDER BY c.created_at DESC`,
          [USER_ROLES.COMPANY_ADMIN, Number(admin.id), scopedCompanyId, hasSearch ? searchLike : '']
        )
      : await pool.query(
          `SELECT c.*,
                  (
                    SELECT u.email
                    FROM users u
                    WHERE u.company_id = c.id
                      AND u.role = $1
                    ORDER BY u.id ASC
                    LIMIT 1
                  ) AS email
           FROM companies c
           WHERE c.is_active = true
             AND (c.super_admin_id = $2 OR ($3::bigint IS NOT NULL AND c.id = $3))
             AND (
               $4::text = ''
               OR c.name ILIKE $4
               OR EXISTS (
                 SELECT 1
                 FROM users su
                 WHERE su.company_id = c.id
                   AND su.role = $1
                   AND su.email ILIKE $4
               )
             )
           ORDER BY c.created_at DESC
           LIMIT $5 OFFSET $6`,
          [
            USER_ROLES.COMPANY_ADMIN,
            Number(admin.id),
            scopedCompanyId,
            hasSearch ? searchLike : '',
            pagination.limit,
            pagination.offset,
          ]
        );

    const totalItems = Number(countResult.rows[0]?.total) || 0;
    const responsePagination = noPagination
      ? buildPaginationMeta(totalItems, 1, totalItems > 0 ? totalItems : 1)
      : buildPaginationMeta(totalItems, pagination.page, pagination.limit);

    return sendSuccess(res, 200, 'Companies fetched successfully.', {
      companies: result.rows.map((row) => ({
        ...mapCompanyRow(row),
        company_admin_email: row.email || null,
      })),
      pagination: responsePagination,
    });
  } catch (error) {
    console.error('getCompanies scoped error:', error);
    return sendError(res, 500, 'Something went wrong while fetching companies.');
  }
}

/**
 * POST /api/v1/companies
 * Company Admin Bearer token (`requireAuth` + `requireCompanyAdmin`).
 * Creates a tenant row in `companies`. A company admin can own multiple companies.
 * Body: M1 company fields (name, currency, country, timezone required; rest optional).
 */
async function createCompany(req, res) {
  const b = req.body || {};

  const trimmedName =
    b.name !== undefined && b.name !== null && String(b.name).trim() ? String(b.name).trim() : '';

  const currencyResult = validateCurrency(b.currency, { required: true });
  if (!currencyResult.valid) {
    return sendError(res, 400, currencyResult.error);
  }
  const currency = currencyResult.value;

  const country =
    b.country !== undefined && b.country !== null && String(b.country).trim()
      ? String(b.country).trim()
      : '';

  const timezone =
    b.timezone !== undefined && b.timezone !== null && String(b.timezone).trim()
      ? String(b.timezone).trim()
      : '';

  if (!trimmedName) {
    return sendError(res, 400, 'Please provide company name.');
  }

  if (trimmedName.length > 120) {
    return sendError(res, 400, 'Company name must be at most 120 characters.');
  }

  if (!country) {
    return sendError(res, 400, 'Please provide country.');
  }

  if (country.length > 80) {
    return sendError(res, 400, 'country must be at most 80 characters.');
  }

  if (!timezone) {
    return sendError(res, 400, 'Please provide timezone (IANA name).');
  }

  if (timezone.length > 80) {
    return sendError(res, 400, 'timezone must be at most 80 characters.');
  }

  let typeVal = null;
  if (b.type !== undefined && b.type !== null && String(b.type).trim()) {
    typeVal = String(b.type).trim();
    if (typeVal.length > 80) {
      return sendError(res, 400, 'type must be at most 80 characters.');
    }
  }

  let salaryMethodVal = null;
  if (b.salary_method !== undefined && b.salary_method !== null && String(b.salary_method).trim()) {
    const sm = String(b.salary_method).trim();
    if (!SALARY_METHODS.has(sm)) {
      return sendError(
        res,
        400,
        'salary_method must be one of: working_days, calendar_days, fixed_days.'
      );
    }
    salaryMethodVal = sm;
  }

  const loanParsed = parseCompanyJsonObject(b.loan_settings);
  if (!loanParsed.ok) {
    return sendError(res, 400, 'loan_settings must be a JSON object.');
  }

  const attendParsed = parseCompanyJsonObject(b.attendance_settings);
  if (!attendParsed.ok) {
    return sendError(res, 400, 'attendance_settings must be a JSON object.');
  }

  let idleTimeoutVal = null;
  if (b.idle_timeout_mins !== undefined && b.idle_timeout_mins !== null) {
    const n = Number(b.idle_timeout_mins);
    if (!Number.isInteger(n) || n < 0) {
      return sendError(res, 400, 'idle_timeout_mins must be a non-negative integer.');
    }
    idleTimeoutVal = n;
  }

  let websiteVal = null;
  if (b.website !== undefined && b.website !== null && String(b.website).trim()) {
    websiteVal = String(b.website).trim();
    if (websiteVal.length > 500) {
      return sendError(res, 400, 'website must be at most 500 characters.');
    }
  }

  let logoUrlVal = null;
  if (b.logo_url !== undefined && b.logo_url !== null && String(b.logo_url).trim()) {
    logoUrlVal = String(b.logo_url).trim();
  }

  let coverUrlVal = null;
  if (b.cover_url !== undefined && b.cover_url !== null && String(b.cover_url).trim()) {
    coverUrlVal = String(b.cover_url).trim();
  }

  const nationalIdMandatory = toBool(b.national_id_mandatory);
  const companyMfaEnabled = toBool(b.mfa_enabled);
  const payslipPwd = toBool(b.payslip_password_protected);
  const sandwichRule = toBool(b.sandwich_rule);

  try {
    const adminResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );

    if (adminResult.rowCount === 0) {
      return sendError(res, 401, 'Authenticated user not found.');
    }

    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can create a company.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }
    const client = await pool.connect();
    let companyRow;
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO companies (
           name, type, logo_url, cover_url, website,
           currency, country, timezone, salary_method,
           national_id_mandatory, mfa_enabled, payslip_password_protected,
           idle_timeout_mins, loan_settings, attendance_settings, sandwich_rule,
           super_admin_id,
           is_active, created_at, updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12,
           $13, $14::jsonb, $15::jsonb, $16,
           $17,
           true, NOW(), NOW()
         )
         RETURNING *`,
        [
          trimmedName,
          typeVal,
          logoUrlVal,
          coverUrlVal,
          websiteVal,
          currency,
          country,
          timezone,
          salaryMethodVal,
          nationalIdMandatory,
          companyMfaEnabled,
          payslipPwd,
          idleTimeoutVal,
          loanParsed.data,
          attendParsed.data,
          sandwichRule,
          admin.id,
        ]
      );

      companyRow = inserted.rows[0];
      const roleIdByName = await seedCompanyDefaultRoles(companyRow.id, client);
      const companyAdminRoleId = roleIdByName['Company Admin'] || null;
      await client.query(
        `UPDATE users
         SET company_id = $1,
             access_role_id = COALESCE($3, access_role_id),
             updated_at = NOW()
         WHERE id = $2 AND company_id IS NULL AND role = $4`,
        [companyRow.id, admin.id, companyAdminRoleId, USER_ROLES.COMPANY_ADMIN]
      );

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      if (err?.code === '42703') {
        return sendError(
          res,
          500,
          'Database schema is out of date. Run the latest `src/db/init.sql` migrations on your database.'
        );
      }
      throw err;
    } finally {
      client.release();
    }

    return sendSuccess(res, 201, 'Company created successfully.', {
      company: mapCompanyRow(companyRow),
    });
  } catch (error) {
    console.error('createCompany error:', error);
    return sendError(res, 500, 'Something went wrong while creating the company.');
  }
}

/**
 * PATCH /api/v1/companies/:id
 * Company Admin Bearer token only. Updates company profile/policy fields.
 * Security: company admin can update only companies they own.
 */
async function updateCompany(req, res) {
  const companyId = Number(req.params.id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return sendError(res, 400, 'Company id must be a positive integer.');
  }

  const b = req.body || {};
  if (!b || Object.keys(b).length === 0) {
    return sendError(res, 400, 'Please provide at least one field to update.');
  }

  const blockedKeys = ['id', 'super_admin_id', 'created_at', 'updated_at'];
  for (const key of blockedKeys) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      return sendError(res, 400, `${key} cannot be updated.`);
    }
  }

  try {
    const adminResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );

    if (adminResult.rowCount === 0) {
      return sendError(res, 401, 'Authenticated user not found.');
    }

    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can update a company.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }
    const scopedCompanyId = resolveScopedCompanyId(admin.company_id, req.authUser?.companyId);
    const ownershipCheck = await pool.query(
      `SELECT id
       FROM companies
       WHERE id = $1
         AND is_active = true
         AND (super_admin_id = $2 OR ($3::bigint IS NOT NULL AND id = $3))`,
      [companyId, admin.id, scopedCompanyId]
    );
    if (ownershipCheck.rowCount === 0) {
      return sendError(res, 403, 'You can only update companies owned by your account.');
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (Object.prototype.hasOwnProperty.call(b, 'name')) {
      const name = String(b.name || '').trim();
      if (!name) return sendError(res, 400, 'name cannot be empty.');
      if (name.length > 120) return sendError(res, 400, 'name must be at most 120 characters.');
      updates.push(`name = $${idx++}`);
      values.push(name);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'company_email')) {
      const companyEmail = String(b.company_email || '').trim().toLowerCase();
      if (!companyEmail) return sendError(res, 400, 'company_email cannot be empty.');
      if (!EMAIL_REGEX.test(companyEmail) || companyEmail.length > 120) {
        return sendError(res, 400, 'company_email must be a valid email address (max 120 chars).');
      }
      updates.push(`company_email = $${idx++}`);
      values.push(companyEmail);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'business_phone_no')) {
      const businessPhone = String(b.business_phone_no || '').trim();
      if (!businessPhone) return sendError(res, 400, 'business_phone_no cannot be empty.');
      if (businessPhone.length > 30) {
        return sendError(res, 400, 'business_phone_no must be at most 30 characters.');
      }
      updates.push(`business_phone_no = $${idx++}`);
      values.push(businessPhone);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'type')) {
      const typeVal =
        b.type === null || String(b.type).trim() === '' ? null : String(b.type).trim();
      if (typeVal && typeVal.length > 80) {
        return sendError(res, 400, 'type must be at most 80 characters.');
      }
      updates.push(`type = $${idx++}`);
      values.push(typeVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'logo_url')) {
      const logoVal =
        b.logo_url === null || String(b.logo_url).trim() === '' ? null : String(b.logo_url).trim();
      updates.push(`logo_url = $${idx++}`);
      values.push(logoVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'cover_url')) {
      const coverVal =
        b.cover_url === null || String(b.cover_url).trim() === ''
          ? null
          : String(b.cover_url).trim();
      updates.push(`cover_url = $${idx++}`);
      values.push(coverVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'website')) {
      const websiteVal =
        b.website === null || String(b.website).trim() === '' ? null : String(b.website).trim();
      if (websiteVal && websiteVal.length > 500) {
        return sendError(res, 400, 'website must be at most 500 characters.');
      }
      updates.push(`website = $${idx++}`);
      values.push(websiteVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'currency')) {
      const currencyResult = validateCurrency(b.currency, { required: true });
      if (!currencyResult.valid) {
        return sendError(res, 400, currencyResult.error);
      }
      updates.push(`currency = $${idx++}`);
      values.push(currencyResult.value);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'country')) {
      const countryVal = String(b.country || '').trim();
      if (!countryVal) return sendError(res, 400, 'country cannot be empty.');
      if (countryVal.length > 80) return sendError(res, 400, 'country must be at most 80 characters.');
      updates.push(`country = $${idx++}`);
      values.push(countryVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'timezone')) {
      const timezoneVal = String(b.timezone || '').trim();
      if (!timezoneVal) return sendError(res, 400, 'timezone cannot be empty.');
      if (timezoneVal.length > 80) return sendError(res, 400, 'timezone must be at most 80 characters.');
      updates.push(`timezone = $${idx++}`);
      values.push(timezoneVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'salary_method')) {
      const salaryVal =
        b.salary_method === null || String(b.salary_method).trim() === ''
          ? null
          : String(b.salary_method).trim();
      if (salaryVal && !SALARY_METHODS.has(salaryVal)) {
        return sendError(
          res,
          400,
          'salary_method must be one of: working_days, calendar_days, fixed_days.'
        );
      }
      updates.push(`salary_method = $${idx++}`);
      values.push(salaryVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'national_id_mandatory')) {
      updates.push(`national_id_mandatory = $${idx++}`);
      values.push(toBool(b.national_id_mandatory));
    }
    if (Object.prototype.hasOwnProperty.call(b, 'mfa_enabled')) {
      updates.push(`mfa_enabled = $${idx++}`);
      values.push(toBool(b.mfa_enabled));
    }
    if (Object.prototype.hasOwnProperty.call(b, 'payslip_password_protected')) {
      updates.push(`payslip_password_protected = $${idx++}`);
      values.push(toBool(b.payslip_password_protected));
    }
    if (Object.prototype.hasOwnProperty.call(b, 'sandwich_rule')) {
      updates.push(`sandwich_rule = $${idx++}`);
      values.push(toBool(b.sandwich_rule));
    }

    if (Object.prototype.hasOwnProperty.call(b, 'idle_timeout_mins')) {
      let idleVal = null;
      if (b.idle_timeout_mins !== null && String(b.idle_timeout_mins).trim() !== '') {
        const n = Number(b.idle_timeout_mins);
        if (!Number.isInteger(n) || n < 0) {
          return sendError(res, 400, 'idle_timeout_mins must be a non-negative integer.');
        }
        idleVal = n;
      }
      updates.push(`idle_timeout_mins = $${idx++}`);
      values.push(idleVal);
    }

    if (Object.prototype.hasOwnProperty.call(b, 'loan_settings')) {
      const parsed = parseCompanyJsonObject(b.loan_settings);
      if (!parsed.ok) return sendError(res, 400, 'loan_settings must be a JSON object.');
      updates.push(`loan_settings = $${idx++}::jsonb`);
      values.push(parsed.data);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'attendance_settings')) {
      const parsed = parseCompanyJsonObject(b.attendance_settings);
      if (!parsed.ok) return sendError(res, 400, 'attendance_settings must be a JSON object.');
      updates.push(`attendance_settings = $${idx++}::jsonb`);
      values.push(parsed.data);
    }

    if (updates.length === 0) {
      return sendError(res, 400, 'No valid updatable company fields were provided.');
    }

    values.push(companyId);
    const wherePos = idx;
    const updated = await pool.query(
      `UPDATE companies
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${wherePos}
       RETURNING *`,
      values
    );

    if (updated.rowCount === 0) {
      return sendError(res, 404, 'Company not found.');
    }

    return sendSuccess(res, 200, 'Company updated successfully.', {
      company: mapCompanyRow(updated.rows[0]),
    });
  } catch (error) {
    console.error('updateCompany error:', error);
    return sendError(res, 500, 'Something went wrong while updating the company.');
  }
}

/**
 * DELETE /api/v1/companies/:id
 * Company Admin Bearer token only. Soft-deletes company (is_active = false).
 * Security: company admin can delete only companies they own.
 */
async function deleteCompany(req, res) {
  const companyId = Number(req.params.id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return sendError(res, 400, 'Company id must be a positive integer.');
  }

  try {
    const adminResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );

    if (adminResult.rowCount === 0) {
      return sendError(res, 401, 'Authenticated user not found.');
    }

    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can delete a company.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }
    const scopedCompanyId = resolveScopedCompanyId(admin.company_id, req.authUser?.companyId);
    const ownershipCheck = await pool.query(
      `SELECT id
       FROM companies
       WHERE id = $1
         AND is_active = true
         AND (super_admin_id = $2 OR ($3::bigint IS NOT NULL AND id = $3))`,
      [companyId, admin.id, scopedCompanyId]
    );
    if (ownershipCheck.rowCount === 0) {
      return sendError(res, 403, 'You can only delete companies owned by your account.');
    }

    const updated = await pool.query(
      `UPDATE companies
       SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND is_active = true
       RETURNING *`,
      [companyId]
    );

    if (updated.rowCount === 0) {
      return sendError(res, 404, 'Company not found or already deleted.');
    }

    return sendSuccess(res, 200, 'Company deleted successfully.', {
      company: mapCompanyRow(updated.rows[0]),
    });
  } catch (error) {
    console.error('deleteCompany error:', error);
    return sendError(res, 500, 'Something went wrong while deleting the company.');
  }
}

module.exports = {
  getPublicCompanies,
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
};

