const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const {
  sendOtpEmail,
  sendPasswordResetCodeEmail,
  sendCompanyAdminInviteEmail,
  sendEmployeeInviteEmail,
  sendEmployeePasswordSetEmail,
  sendPasswordChangedEmail,
  sendResetPasswordEmail,
} = require('../services/email.service');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { formatAuthUser, loginSuccessMessageEn, splitFullName } = require('../utils/authUserFormatter');
const { parseOptionalDateInput } = require('../utils/dateTime');
const { fetchCompanyBranding } = require('../utils/companyBranding');
const employeeNested = require('../services/employeeNested.service');
const deviceTokenService = require('../services/deviceToken.service');
const { buildAuthPermissionPayload } = require('../services/accessControl.service');
const { seedCompanyDefaultRoles } = require('../services/accessRoles.service');
const { validateCurrency } = require('../utils/currencyValidation');

const OTP_EXPIRY_MINUTES = 15;
const JWT_EXPIRES_IN = '1d';
const COMPANY_ADMIN_INVITE_EXPIRES_IN = '7d';
const COMPANY_ADMIN_SETUP_EXPIRES_IN = '1h';

const COMPANY_ADMIN_INVITE_PURPOSE = 'company-admin-invite';
const COMPANY_ADMIN_SETUP_PURPOSE = 'company-admin-setup';
const EMPLOYEE_INVITE_EXPIRES_IN = '7d';
const EMPLOYEE_SETUP_EXPIRES_IN = '1h';
const EMPLOYEE_INVITE_PURPOSE = 'employee-invite';
const EMPLOYEE_SETUP_PURPOSE = 'employee-setup';
const PASSWORD_RESET_PURPOSE = 'password-reset';
const PASSWORD_RESET_EXPIRES_IN = '15m';
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SALARY_METHODS = new Set(['working_days', 'calendar_days', 'fixed_days']);
const PROFILE_GENDERS = new Set(['male', 'female', 'other']);

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Strips non-digits so values like "315831." or "315 831" still verify. */
function normalizeOtpInput(otp) {
  return String(otp ?? '').replace(/\D/g, '');
}

/** True once a real password is set (invited company admins use '' until create-profile). */
function hasUsablePassword(hash) {
  return hash != null && String(hash).trim().length > 0;
}

function isEmployeeRole(role) {
  return role === USER_ROLES.EMPLOYEE || role === USER_ROLES.DEPARTMENT_MANAGER;
}

/** Invite employee completed verify + password but company admin has not activated yet. */
function isEmployeePendingApproval(user) {
  return (
    isEmployeeRole(user.role) &&
    user.is_active === false &&
    user.is_email_verified === true &&
    hasUsablePassword(user.password_hash)
  );
}



/** Invite employee has not verified email yet (password may or may not be set). */
function isEmployeeAwaitingVerification(user) {
  return isEmployeeRole(user.role) && user.is_email_verified !== true;
}

function isEmployeePasswordNotSet(user) {
  return isEmployeeRole(user.role) && user.is_email_verified === true && !hasUsablePassword(user.password_hash);
}

function buildOtpExpiryTime() {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
}

function buildTokenPayload(user) {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    companyId: user.company_id ?? null,
  };
}

async function issueAccessToken(user) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return { error: 'Server configuration error. Please try again later.' };
  }

  const token = jwt.sign(buildTokenPayload(user), jwtSecret, {
    expiresIn: JWT_EXPIRES_IN,
  });
  const decoded = jwt.decode(token);
  const tokenExpiresAt =
    decoded && decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null;

  await pool.query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [
    user.id,
  ]);

  return {
    token,
    token_expires_at: tokenExpiresAt,
    expires_in: JWT_EXPIRES_IN,
  };
}

function issuePasswordResetToken(user) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('Server configuration error. Please try again later.');
  }

  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      purpose: PASSWORD_RESET_PURPOSE,
    },
    jwtSecret,
    {
      expiresIn: PASSWORD_RESET_EXPIRES_IN,
    }
  );
}

const USER_ROW_SQL = `id, company_id, employee_id, access_role_id, full_name, email, password_hash, role, is_active, is_email_verified,
  profile_picture_url, otp_code, otp_expires_at, last_login_at, device_id, signup_type, phone_number,
  mfa_enabled, dob, created_at, updated_at`;

/** Company summary for employees (id, name, logo, email). */
function formatCompanySummaryForProfile(c) {
  const logoUrl = c.logo_url ?? null;
  return {
    id: Number(c.id),
    name: c.name,
    company_name: c.name,
    company_email: c.company_email ?? null,
    email: c.company_email ?? null,
    logo_url: logoUrl,
    company_logo: logoUrl,
    business_phone_no: c.business_phone_no ?? null,
    type: c.type ?? null,
    currency: c.currency ?? null,
    country: c.country ?? null,
    timezone: c.timezone ?? null,
    salary_method: c.salary_method ?? null,
  };
}

/** Full company object for company admin profile. */
function formatCompanyFullForProfile(c) {
  return {
    ...formatCompanySummaryForProfile(c),
    business_phone_no: c.business_phone_no ?? null,
    type: c.type ?? null,
    logo_url: c.logo_url ?? null,
    cover_url: c.cover_url ?? null,
    website: c.website ?? null,
    currency: c.currency ?? null,
    country: c.country ?? null,
    timezone: c.timezone ?? null,
    salary_method: c.salary_method ?? null,
    national_id_mandatory: c.national_id_mandatory === true,
    mfa_enabled: c.mfa_enabled === true,
    payslip_password_protected: c.payslip_password_protected === true,
    idle_timeout_mins:
      c.idle_timeout_mins !== undefined && c.idle_timeout_mins !== null
        ? Number(c.idle_timeout_mins)
        : null,
    loan_settings: c.loan_settings && typeof c.loan_settings === 'object' ? c.loan_settings : {},
    attendance_settings:
      c.attendance_settings && typeof c.attendance_settings === 'object'
        ? c.attendance_settings
        : {},
    sandwich_rule: c.sandwich_rule === true,
    is_active: c.is_active === true,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

async function loadCompanyForProfile(db, companyId, role) {
  if (!companyId) return null;
  const companyResult = await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
  if (companyResult.rowCount === 0) return null;
  const c = companyResult.rows[0];
  if (role === USER_ROLES.COMPANY_ADMIN) {
    return formatCompanyFullForProfile(c);
  }
  if (isEmployeeRole(role)) {
    return formatCompanySummaryForProfile(c);
  }
  return formatCompanySummaryForProfile(c);
}

function buildCompanyAdminInviteUrl(inviteToken) {
  const base =
    process.env.COMPANY_ADMIN_INVITE_URL ||
    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-company-admin`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(inviteToken)}`;
}

function buildEmployeeInviteUrl(inviteToken) {
  const base =
    process.env.EMPLOYEE_INVITE_URL ||
    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-employee`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(inviteToken)}`;
}

function buildEmployeeSetPasswordUrl(setupToken) {
  const base =
    process.env.EMPLOYEE_SET_PASSWORD_URL ||
    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/set-employee-password`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(setupToken)}`;
}

function verifyEmployeeInviteToken(token, jwtSecret) {
  if (!token || !String(token).trim()) {
    return {
      ok: false,
      statusCode: 400,
      code: 'token_required',
      message: 'Please provide token.',
    };
  }

  try {
    const decoded = jwt.verify(String(token).trim(), jwtSecret);
    if (decoded.purpose !== EMPLOYEE_INVITE_PURPOSE) {
      return {
        ok: false,
        statusCode: 400,
        code: 'token_invalid',
        message: 'Your invitation link is invalid. Please request a new invitation.',
      };
    }
    return { ok: true, decoded };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return {
        ok: false,
        statusCode: 400,
        code: 'token_expired',
        message: 'Your invitation link has expired. Please request a new invitation.',
      };
    }
    return {
      ok: false,
      statusCode: 400,
      code: 'token_invalid',
      message: 'Your invitation link is invalid. Please request a new invitation.',
    };
  }
}

async function sendEmployeeInviteForUser(user, jwtSecret) {
  const inviteToken = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.company_id,
      purpose: EMPLOYEE_INVITE_PURPOSE,
    },
    jwtSecret,
    { expiresIn: EMPLOYEE_INVITE_EXPIRES_IN }
  );

  const inviteUrl = buildEmployeeInviteUrl(inviteToken);
  const branding = await fetchCompanyBranding(user.company_id);
  let emailResult = { sent: false, reason: 'unknown error' };
  try {
    emailResult = await sendEmployeeInviteEmail(user.email, inviteUrl, {
      companyId: user.company_id,
      ...branding,
    });
  } catch (mailError) {
    emailResult = { sent: false, reason: mailError.message };
  }
  if (!emailResult.sent) {
    console.error(`Email failed for employee invite (${user.email}): ${emailResult.reason}`);
  }

  return { inviteUrl, emailResult };
}

async function sendEmployeePasswordSetLinkForUser(user, jwtSecret) {
  const setupToken = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      companyId: user.company_id,
      purpose: EMPLOYEE_SETUP_PURPOSE,
    },
    jwtSecret,
    { expiresIn: EMPLOYEE_SETUP_EXPIRES_IN }
  );
  

  const setPasswordUrl = buildEmployeeSetPasswordUrl(setupToken);
  const branding = await fetchCompanyBranding(user.company_id);
  let emailResult = { sent: false, reason: 'unknown error' };
  try {
    emailResult = await sendEmployeePasswordSetEmail(user.email, setPasswordUrl, {
      companyId: user.company_id,
      ...branding,
    });
  } catch (mailError) {
    emailResult = { sent: false, reason: mailError.message };
  }
  if (!emailResult.sent) {
    console.error(`Email failed for password set link (${user.email}): ${emailResult.reason}`);
  }

  return { setPasswordUrl, setupToken, emailResult };
}

function toBoolMfa(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return false;
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

function hasPendingCompanyAdminProfile(fullName) {
  return !fullName || String(fullName).trim().toLowerCase() === 'pending profile';
}

async function loadUserRowById(id) {
  const result = await pool.query(`SELECT ${USER_ROW_SQL} FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/**
 * POST /api/v1/auth/super-admin/company-admins
 * Super Admin JWT only. Body: email, role (company_admin), name?
 * Invited users are created without `company_id`; the Company Admin creates the company after login.
 */
async function createCompanyAdminInvite(req, res) {
  const { email, role, name, company_id, companyId, id } = req.body || {};

  if (!email || !role) {
    return sendError(res, 400, 'Please provide email and role.');
  }

  if (String(role).trim() !== USER_ROLES.COMPANY_ADMIN) {
    return sendError(res, 400, 'Role must be company_admin.');
  }

  const incomingCompanyId = company_id ?? companyId ?? id;
  if (
    incomingCompanyId !== undefined &&
    incomingCompanyId !== null &&
    String(incomingCompanyId).trim()
  ) {
    return sendError(
      res,
      400,
      'Do not send company_id. Company admins create and link their company after completing setup.'
    );
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const displayName =
    name !== undefined && name !== null && String(name).trim()
      ? String(name).trim()
      : normalizedEmail.split('@')[0] || 'Company Admin';

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rowCount > 0) {
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const companyIdValue = null;

    const insert = await pool.query(
      `INSERT INTO users (
        company_id, employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
        mfa_enabled, signup_type, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, true, false, false, 'invite', NOW(), NOW())
      RETURNING ${USER_ROW_SQL}`,
      [companyIdValue, null, displayName, normalizedEmail, '', USER_ROLES.COMPANY_ADMIN]
    );

    const row = insert.rows[0];
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return sendError(res, 500, 'Server configuration error. Please try again later.');
    }

    const inviteToken = jwt.sign(
      {
        userId: row.id,
        email: row.email,
        role: row.role,
        purpose: COMPANY_ADMIN_INVITE_PURPOSE,
      },
      jwtSecret,
      { expiresIn: COMPANY_ADMIN_INVITE_EXPIRES_IN }
    );

    const inviteUrl = buildCompanyAdminInviteUrl(inviteToken);

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendCompanyAdminInviteEmail(normalizedEmail, inviteUrl);
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for company admin invite (${normalizedEmail}): ${emailResult.reason}`);
    }

    return sendSuccess(res, 201, 'Company admin invitation sent successfully.', {
      email: normalizedEmail,
      role: USER_ROLES.COMPANY_ADMIN,
      name: displayName,
      company_id: companyIdValue,
      invite_url: inviteUrl,
    });
  } catch (error) {
    console.error('createCompanyAdminInvite error:', error);
    return sendError(res, 500, 'Something went wrong while creating the invitation.');
  }
}

/** POST /api/v1/auth/company-admin/verify-account — body: { token } from invite link */
async function verifyCompanyAdminAccount(req, res) {
  const { token } = req.body || {};
  if (!token) {
    return sendError(res, 400, 'Please provide token.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(String(token).trim(), jwtSecret);
  } catch {
    return sendError(res, 400, 'Invalid or expired invitation token.');
  }

  if (decoded.purpose !== COMPANY_ADMIN_INVITE_PURPOSE || decoded.role !== USER_ROLES.COMPANY_ADMIN) {
    return sendError(res, 400, 'Invalid invitation token.');
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, is_active, is_email_verified, password_hash, full_name FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }

    const u = userResult.rows[0];
    if (!u.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    if (hasUsablePassword(u.password_hash)) {
      return sendError(res, 400, 'This account is already set up. You can log in.');
    }

    if (!u.is_email_verified) {
      await pool.query(`UPDATE users SET is_email_verified = true, updated_at = NOW() WHERE id = $1`, [
        u.id,
      ]);
    }

    const setupToken = jwt.sign(
      {
        userId: u.id,
        email: u.email,
        purpose: COMPANY_ADMIN_SETUP_PURPOSE,
      },
      jwtSecret,
      { expiresIn: COMPANY_ADMIN_SETUP_EXPIRES_IN }
    );

    return sendSuccess(res, 200, 'Company admin account verified successfully.', {
      setup_token: setupToken,
      expires_in: COMPANY_ADMIN_SETUP_EXPIRES_IN,
    });
  } catch (error) {
    console.error('verifyCompanyAdminAccount error:', error);
    return sendError(res, 500, 'Something went wrong while verifying your account.');
  }
}

/** POST /api/v1/auth/company-admin/create-profile — Authorization: Bearer setup_token */
async function createCompanyAdminProfile(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return sendError(res, 401, 'Invalid or expired setup token.');
  }

  if (decoded.purpose !== COMPANY_ADMIN_SETUP_PURPOSE) {
    return sendError(res, 401, 'Invalid setup token.');
  }

  const { first_name, last_name, phone_number, dob, profile_picture, password } = req.body || {};

  if (!first_name || !last_name || !phone_number) {
    return sendError(
      res,
      400,
      'Please provide first_name, last_name, and phone_number.'
    );
  }

  const dobParsed = parseOptionalDateInput(dob, 'dob');
  if (dobParsed.error) {
    return sendError(res, 400, dobParsed.error);
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, is_active, is_email_verified, password_hash, full_name FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }

    const u = userResult.rows[0];
    if (u.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'This endpoint is only for company administrators.');
    }

    if (!u.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    if (!u.is_email_verified) {
      return sendError(res, 403, 'Please verify your account first using the invitation link.');
    }

    const canCompletePendingProfile =
      hasUsablePassword(u.password_hash) && hasPendingCompanyAdminProfile(u.full_name);
    if (hasUsablePassword(u.password_hash) && !canCompletePendingProfile) {
      return sendError(res, 400, 'Profile is already complete. Use login or update profile.');
    }

    const fn = String(first_name).trim();
    const ln = String(last_name).trim();
    if (!fn || !ln) {
      return sendError(res, 400, 'first_name and last_name cannot be empty.');
    }

    const phone = String(phone_number).trim();
    if (!phone) {
      return sendError(res, 400, 'phone_number cannot be empty.');
    }

    const fullName = `${fn} ${ln}`;
    const profileUrl =
      profile_picture !== undefined && profile_picture !== null && String(profile_picture).trim()
        ? String(profile_picture).trim()
        : null;

    const dobValue = dobParsed.value;

    if (hasUsablePassword(u.password_hash)) {
      await pool.query(
        `UPDATE users
         SET full_name = $1,
             phone_number = $2,
             dob = $3::date,
             profile_picture_url = COALESCE($4, profile_picture_url),
             signup_type = 'email',
             updated_at = NOW()
         WHERE id = $5`,
        [fullName, phone, dobValue, profileUrl, u.id]
      );
    } else {
      if (!password) {
        return sendError(res, 400, 'Please provide password.');
      }
      if (!PASSWORD_REGEX.test(password)) {
        return sendError(
          res,
          400,
          'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
        );
      }

      const password_hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users
         SET full_name = $1,
             phone_number = $2,
             dob = $3::date,
             profile_picture_url = COALESCE($4, profile_picture_url),
             password_hash = $5,
             signup_type = 'email',
             updated_at = NOW()
         WHERE id = $6`,
        [fullName, phone, dobValue, profileUrl, password_hash, u.id]
      );
    }

    const updated = await loadUserRowById(u.id);
    const userDto = formatAuthUser(updated);

    return sendSuccess(res, 200, 'Company admin profile created successfully.', {
      company_id: userDto.company_id,
      user: userDto,
    });
  } catch (error) {
    console.error('createCompanyAdminProfile error:', error);
    return sendError(res, 500, 'Something went wrong while saving your profile.');
  }
}

/** POST /api/v1/auth/company-admin/create-company — Authorization: Bearer setup_token */
async function createCompanyWithSetupToken(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account/verify-otp.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account/verify-otp.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return sendError(res, 401, 'Invalid or expired setup token.');
  }

  if (decoded.purpose !== COMPANY_ADMIN_SETUP_PURPOSE) {
    return sendError(res, 401, 'Invalid setup token.');
  }

  const b = req.body || {};
  const trimmedName =
    b.name !== undefined && b.name !== null && String(b.name).trim() ? String(b.name).trim() : '';
  const companyEmail =
    b.company_email !== undefined && b.company_email !== null && String(b.company_email).trim()
      ? String(b.company_email).trim().toLowerCase()
      : '';
  const currencyResult = validateCurrency(b.currency, { required: true });
  if (!currencyResult.valid) {
    return sendError(res, 400, currencyResult.error);
  }
  const currency = currencyResult.value;
  const country =
    b.country !== undefined && b.country !== null && String(b.country).trim()
      ? String(b.country).trim()
      : '';
  const businessPhoneNo =
    b.business_phone_no !== undefined && b.business_phone_no !== null && String(b.business_phone_no).trim()
      ? String(b.business_phone_no).trim()
      : '';

  if (!trimmedName) return sendError(res, 400, 'Please provide company name.');
  if (trimmedName.length > 120) return sendError(res, 400, 'Company name must be at most 120 characters.');
  if (!companyEmail) return sendError(res, 400, 'Please provide company_email.');
  if (companyEmail.length > 120 || !EMAIL_REGEX.test(companyEmail)) {
    return sendError(res, 400, 'company_email must be a valid email address (max 120 chars).');
  }
  if (!country) return sendError(res, 400, 'Please provide country.');
  if (country.length > 80) return sendError(res, 400, 'country must be at most 80 characters.');
  if (!businessPhoneNo) return sendError(res, 400, 'Please provide business_phone_no.');
  if (businessPhoneNo.length > 30) return sendError(res, 400, 'business_phone_no must be at most 30 characters.');

  let typeVal = null;
  if (b.type !== undefined && b.type !== null && String(b.type).trim()) {
    typeVal = String(b.type).trim();
    if (typeVal.length > 80) return sendError(res, 400, 'type must be at most 80 characters.');
  }

  let salaryMethodVal = null;
  if (b.salary_method !== undefined && b.salary_method !== null && String(b.salary_method).trim()) {
    const sm = String(b.salary_method).trim();
    if (!SALARY_METHODS.has(sm)) {
      return sendError(res, 400, 'salary_method must be one of: working_days, calendar_days, fixed_days.');
    }
    salaryMethodVal = sm;
  }

  const loanParsed = parseCompanyJsonObject(b.loan_settings);
  if (!loanParsed.ok) return sendError(res, 400, 'loan_settings must be a JSON object.');

  const attendParsed = parseCompanyJsonObject(b.attendance_settings);
  if (!attendParsed.ok) return sendError(res, 400, 'attendance_settings must be a JSON object.');

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
    if (websiteVal.length > 500) return sendError(res, 400, 'website must be at most 500 characters.');
  }

  let logoUrlVal = null;
  if (b.logo_url !== undefined && b.logo_url !== null && String(b.logo_url).trim()) {
    logoUrlVal = String(b.logo_url).trim();
  }

  let coverUrlVal = null;
  if (b.cover_url !== undefined && b.cover_url !== null && String(b.cover_url).trim()) {
    coverUrlVal = String(b.cover_url).trim();
  }

  const nationalIdMandatory = toBoolMfa(b.national_id_mandatory);
  const companyMfaEnabled = toBoolMfa(b.mfa_enabled);
  const payslipPwd = toBoolMfa(b.payslip_password_protected);
  const sandwichRule = toBoolMfa(b.sandwich_rule);

  try {
    const userResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );
    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }
    const admin = userResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'This endpoint is only for company administrators.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }
    if (!admin.is_email_verified) {
      return sendError(res, 403, 'Please verify your account first.');
    }
    if (hasPendingCompanyAdminProfile(admin.full_name)) {
      return sendError(res, 400, 'Please complete profile first before creating company.');
    }

    const client = await pool.connect();
    let companyRow;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO companies (
           name, company_email, business_phone_no, type, logo_url, cover_url, website,
           currency, country, timezone, salary_method,
           national_id_mandatory, mfa_enabled, payslip_password_protected,
           idle_timeout_mins, loan_settings, attendance_settings, sandwich_rule,
           super_admin_id,
           is_active, created_at, updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13, $14,
           $15, $16::jsonb, $17::jsonb, $18,
           $19,
           true, NOW(), NOW()
         )
         RETURNING *`,
        [
          trimmedName,
          companyEmail,
          businessPhoneNo,
          typeVal,
          logoUrlVal,
          coverUrlVal,
          websiteVal,
          currency,
          country,
          null,
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
         WHERE id = $2 AND role = $4`,
        [companyRow.id, admin.id, companyAdminRoleId, USER_ROLES.COMPANY_ADMIN]
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }

    return sendSuccess(res, 201, 'Company created successfully.', {
      company: companyRow,
      company_id: companyRow.id,
    });
  } catch (error) {
    console.error('createCompanyWithSetupToken error:', error);
    return sendError(res, 500, 'Something went wrong while creating the company.');
  }
}

/** POST /api/v1/auth/company-admin/employees — employees do not use MFA (mfa_enabled always false). */
async function createEmployeeInvite(req, res) {
  const { email, role, name } = req.body || {};

  if (!email || !role) {
    return sendError(res, 400, 'Please provide email and role.');
  }

  const normalizedRole = String(role).trim();
  if (normalizedRole !== USER_ROLES.EMPLOYEE && normalizedRole !== USER_ROLES.DEPARTMENT_MANAGER) {
    return sendError(res, 400, 'Role must be employee or department_manager.');
  }
  

  const normalizedEmail = String(email).toLowerCase().trim();
  const displayName =
    name !== undefined && name !== null && String(name).trim()
      ? String(name).trim()
      : normalizedEmail.split('@')[0] || 'Employee';

  try {
    const adminResult = await pool.query(
      `SELECT id, company_id, role, is_active
       FROM users
       WHERE id = $1 AND email = $2`,
      [req.authUser.userId, req.authUser.email]
    );
    if (adminResult.rowCount === 0) {
      return sendError(res, 401, 'Authenticated company admin not found.');
    }

    const admin = adminResult.rows[0];
    if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can perform this action.');
    }
    if (!admin.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }
    if (!admin.company_id) {
      return sendError(
        res,
        400,
        'Your account is not linked to any company. Ask Super Admin to assign company_id first.'
      );
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rowCount > 0) {
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const insert = await pool.query(
      `INSERT INTO users (
        company_id, employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
        mfa_enabled, signup_type, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, true, false, false, 'invite', NOW(), NOW())
      RETURNING ${USER_ROW_SQL}`,
      [admin.company_id, null, displayName, normalizedEmail, '', normalizedRole]
    );

    const row = insert.rows[0];
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return sendError(res, 500, 'Server configuration error. Please try again later.');
    }

    const inviteToken = jwt.sign(
      { 
        userId: row.id,
        email: row.email,
        role: row.role,
        companyId: row.company_id,
        purpose: EMPLOYEE_INVITE_PURPOSE,
      },
      jwtSecret,
      { expiresIn: EMPLOYEE_INVITE_EXPIRES_IN }
    );

    const inviteUrl = buildEmployeeInviteUrl(inviteToken);
    const branding = await fetchCompanyBranding(row.company_id);
    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendEmployeeInviteEmail(normalizedEmail, inviteUrl, {
        companyId: row.company_id,
        ...branding,
      });
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for employee invite (${normalizedEmail}): ${emailResult.reason}`);
    }

    return sendSuccess(res, 201, 'Employee invitation sent successfully.', {
      email: normalizedEmail,
      role: normalizedRole,
      name: displayName,
      company_id: row.company_id,
      invite_url: inviteUrl,
    });
  } catch (error) {
    console.error('createEmployeeInvite error:', error);
    return sendError(res, 500, 'Something went wrong while creating the employee invitation.');
  }
}

/** POST /api/v1/auth/employee/verify-account */
async function verifyEmployeeAccount(req, res) {
  const { token } = req.body || {};

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  const tokenResult = verifyEmployeeInviteToken(token, jwtSecret);
  if (!tokenResult.ok) {
    return sendError(res, tokenResult.statusCode, tokenResult.message, { code: tokenResult.code });
  }

  const decoded = tokenResult.decoded;

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, company_id, is_active, is_email_verified, password_hash, signup_type
       FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );
    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.', { code: 'user_not_found' });
    }

    const u = userResult.rows[0];
    if (u.role !== USER_ROLES.EMPLOYEE && u.role !== USER_ROLES.DEPARTMENT_MANAGER) {
      return sendError(res, 403, 'This invitation is not for an employee account.', {
        code: 'invalid_invitation',
      });
    }
    if (hasUsablePassword(u.password_hash)) {
      if (isEmployeePendingApproval(u)) {
        return sendError(
          res,
          400,
          'Your account is pending approval from your company administrator.',
          { code: 'pending_approval' }
        );
      }
      return sendError(res, 400, 'This account is already set up. Please log in.', {
        code: 'account_already_setup',
      });
    }

    if (!u.is_email_verified) {
      await pool.query(`UPDATE users SET is_email_verified = true, updated_at = NOW() WHERE id = $1`, [
        u.id,
      ]);
    }

    const setupToken = jwt.sign(
      {
        userId: u.id,
        email: u.email,
        companyId: u.company_id,
        purpose: EMPLOYEE_SETUP_PURPOSE,
      },
      jwtSecret,
      { expiresIn: EMPLOYEE_SETUP_EXPIRES_IN }
    );

    return sendSuccess(res, 200, 'Employee account verified successfully.', {
      setup_token: setupToken,
      expires_in: EMPLOYEE_SETUP_EXPIRES_IN,
      company_id: u.company_id,
    });
  } catch (error) {
    console.error('verifyEmployeeAccount error:', error);
    return sendError(res, 500, 'Something went wrong while verifying your account.');
  }
}

/** POST /api/v1/auth/employee/resend-invite — body: { email } */
async function resendEmployeeInvite(req, res) {
  const { email } = req.body || {};

  if (!email || !String(email).trim()) {
    return sendError(res, 400, 'Please provide email.', { code: 'email_required' });
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'Please provide a valid email address.', { code: 'invalid_email' });
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, company_id, signup_type, is_active, is_email_verified, password_hash
       FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'No employee invitation found for this email.', {
        code: 'invitation_not_found',
      });
    }

    const u = userResult.rows[0];

    if (!isEmployeeRole(u.role)) {
      return sendError(res, 400, 'This email is not associated with an employee invitation.', {
        code: 'not_employee_invite',
      });
    }

    if (u.signup_type !== 'invite') {
      return sendError(res, 400, 'This account is not on the employee invite flow.', {
        code: 'not_invite_account',
      });
    }

    if (u.is_email_verified) {
      return sendError(res, 400, 'This account is already verified. Please log in.', {
        code: 'account_already_verified',
      });
    }

    const otpCode = generateOtp();
    const otpExpiresAt = buildOtpExpiryTime();
    await pool.query(
      `UPDATE users
       SET otp_code = $1, otp_expires_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [otpCode, otpExpiresAt, u.id]
    );

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      const branding = await fetchCompanyBranding(u.company_id);
      emailResult = await sendOtpEmail(normalizedEmail, otpCode, {
        companyId: u.company_id,
        ...branding,
      });
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for employee OTP (${normalizedEmail}): ${emailResult.reason}`);
    }

    const msg = emailResult.sent
      ? 'A new verification OTP has been sent to your email.'
      : 'A new verification OTP has been generated.';

    return sendSuccess(res, 200, msg, {
      email: normalizedEmail,
      otp_email_sent: Boolean(emailResult.sent),
      otp_email_error: emailResult.sent ? null : emailResult.reason,
      otp_expires_at: otpExpiresAt.toISOString(),
    });
  } catch (error) {
    console.error('resendEmployeeInvite error:', error);
    return sendError(res, 500, 'Something went wrong while resending the verification OTP.');
  }
}

/** POST /api/v1/auth/employee/resend-password-link — body: { email } */
async function resendEmployeePasswordSetLink(req, res) {
  const { email } = req.body || {};

  if (!email || !String(email).trim()) {
    return sendError(res, 400, 'Please provide email.', { code: 'email_required' });
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return sendError(res, 400, 'Please provide a valid email address.', { code: 'invalid_email' });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, company_id, signup_type, is_active, is_email_verified, password_hash
       FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'No employee account found for this email.', {
        code: 'account_not_found',
      });
    }

    const u = userResult.rows[0];

    if (!isEmployeeRole(u.role)) {
      return sendError(res, 400, 'This email is not associated with an employee account.', {
        code: 'not_employee_account',
      });
    }

    if (!u.is_email_verified) {
      return sendError(
        res,
        400,
        'Your account is not verified yet. Please verify it with the OTP sent to your email.',
        { code: 'account_not_verified', verification_method: 'otp' }
      );
    }

    if (hasUsablePassword(u.password_hash)) {
      if (isEmployeePendingApproval(u)) {
        return sendError(
          res,
          400,
          'Your account is pending approval from your company administrator.',
          { code: 'pending_approval' }
        );
      }
      return sendError(res, 400, 'Password is already set. Please log in.', {
        code: 'password_already_set',
      });
    }

    const { setPasswordUrl, setupToken, emailResult } = await sendEmployeePasswordSetLinkForUser(
      u,
      jwtSecret
    );

    const msg = emailResult.sent
      ? 'A password set link has been sent to your email.'
      : 'A password set link has been generated.';

    return sendSuccess(res, 200, msg, {
      email: normalizedEmail,
      password_set_email_sent: Boolean(emailResult.sent),
      set_password_url: setPasswordUrl,
      setup_token: setupToken,
      expires_in: EMPLOYEE_SETUP_EXPIRES_IN,
    });
  } catch (error) {
    console.error('resendEmployeePasswordSetLink error:', error);
    return sendError(res, 500, 'Something went wrong while sending the password set link.');
  }
}

/** POST /api/v1/auth/employee/set-password — Authorization: Bearer setup_token from verify-account */
async function setEmployeePassword(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Setup token is required. Use the setup_token from verify-account.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Setup token is required. Use the setup_token from verify-account.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return sendError(res, 401, 'Invalid or expired setup token.');
  }

  if (decoded.purpose !== EMPLOYEE_SETUP_PURPOSE) {
    return sendError(res, 401, 'Invalid setup token.');
  }

  const { password, new_password, newPassword, confirm_password, confirmPassword } = req.body || {};
  const passwordValue = password ?? new_password ?? newPassword;
  const confirmValue = confirm_password ?? confirmPassword;

  if (!passwordValue) {
    return sendError(res, 400, 'Please provide password.');
  }

  if (confirmValue !== undefined && confirmValue !== null && String(confirmValue) !== String(passwordValue)) {
    return sendError(res, 400, 'Password and confirm_password do not match.');
  }

  if (!PASSWORD_REGEX.test(String(passwordValue))) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, role, company_id, full_name, is_active, is_email_verified, password_hash
       FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );
    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }

    const u = userResult.rows[0];
    if (u.role !== USER_ROLES.EMPLOYEE && u.role !== USER_ROLES.DEPARTMENT_MANAGER) {
      return sendError(res, 403, 'This endpoint is only for employee accounts.');
    }
    if (!u.is_email_verified) {
      return sendError(res, 403, 'Please verify your account first using the invitation link.');
    }
    if (hasUsablePassword(u.password_hash)) {
      return sendError(res, 400, 'Password is already set.');
    }

    const invitedCompanyId = Number(decoded.companyId);
    const companyId =
      Number.isInteger(invitedCompanyId) && invitedCompanyId > 0 ? invitedCompanyId : u.company_id;

    if (companyId) {
      const companyCheck = await pool.query('SELECT id, is_active FROM companies WHERE id = $1', [
        companyId,
      ]);
      if (companyCheck.rowCount === 0) {
        return sendError(res, 404, 'Company not found.');
      }
      if (!companyCheck.rows[0].is_active) {
        return sendError(res, 400, 'Your company account is inactive.');
      }
    }

    const password_hash = await bcrypt.hash(String(passwordValue), 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           company_id = COALESCE(company_id, $2),
           updated_at = NOW()
       WHERE id = $3`,
      [password_hash, companyId, u.id]
    );

    const updated = await loadUserRowById(u.id);
    const userDto = formatAuthUser(updated);

    return sendSuccess(
      res,
      200,
      'Password set successfully. Your account is pending approval from your company administrator.',
      {
        user: userDto,
        company_id: updated.company_id ?? null,
        status: 'pending_approval',
      }
    );
  } catch (error) {
    console.error('setEmployeePassword error:', error);
    return sendError(res, 500, 'Something went wrong while setting your password.');
  }
}

/** POST /api/v1/auth/employee/create-profile — Authorization: Bearer setup_token */
async function createEmployeeProfile(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Setup token is required. Use the token from verify-account.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return sendError(res, 401, 'Invalid or expired setup token.');
  }
  if (decoded.purpose !== EMPLOYEE_SETUP_PURPOSE) {
    return sendError(res, 401, 'Invalid setup token.');
  }

  const {
    first_name,
    last_name,
    phone_number,
    dob,
    profile_picture,
    password,
    company_id,
    companyId,
  } = req.body || {};
  const invitedCompanyId = Number(decoded.companyId);
  const hasInvitedCompanyId = Number.isInteger(invitedCompanyId) && invitedCompanyId > 0;
  if (!first_name || !last_name || !phone_number || !password || (!hasInvitedCompanyId && !company_id && !companyId)) {
    return sendError(
      res,
      400,
      'Please provide first_name, last_name, phone_number, password, and company_id.'
    );
  }
  const employeeDobParsed = parseOptionalDateInput(dob, 'dob');
  if (employeeDobParsed.error) {
    return sendError(res, 400, employeeDobParsed.error);
  }
  if (!PASSWORD_REGEX.test(password)) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  try {
    const incomingCompanyId = company_id ?? companyId;
    let parsedCompanyId = invitedCompanyId;
    if (!hasInvitedCompanyId) {
      parsedCompanyId = Number(incomingCompanyId);
      if (!Number.isInteger(parsedCompanyId) || parsedCompanyId <= 0) {
        return sendError(res, 400, 'company_id must be a valid positive integer.');
      }
    } else if (incomingCompanyId !== undefined && incomingCompanyId !== null) {
      const requestedCompanyId = Number(incomingCompanyId);
      if (Number.isInteger(requestedCompanyId) && requestedCompanyId > 0 && requestedCompanyId !== invitedCompanyId) {
        return sendError(
          res,
          403,
          'You must complete your profile with the company from your invitation.'
        );
      }
    }

    const companyCheck = await pool.query('SELECT id, is_active FROM companies WHERE id = $1', [
      parsedCompanyId,
    ]);
    if (companyCheck.rowCount === 0) {
      return sendError(res, 404, 'Company not found.');
    }
    if (!companyCheck.rows[0].is_active) {
      return sendError(res, 400, 'Selected company is inactive.');
    }

    const userResult = await pool.query(
      `SELECT id, email, role, company_id, is_active, is_email_verified, password_hash
       FROM users WHERE id = $1 AND email = $2`,
      [decoded.userId, decoded.email]
    );
    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }
    const u = userResult.rows[0];
    if (u.role !== USER_ROLES.EMPLOYEE && u.role !== USER_ROLES.DEPARTMENT_MANAGER) {
      return sendError(res, 403, 'This endpoint is only for employee accounts.');
    }
    if (!u.is_email_verified) {
      return sendError(res, 403, 'Please verify your account first using the invitation link.');
    }
    if (hasUsablePassword(u.password_hash)) {
      return sendError(res, 400, 'Profile is already complete. Use login or update profile.');
    }

    const fn = String(first_name).trim();
    const ln = String(last_name).trim();
    const phone = String(phone_number).trim();
    if (!fn || !ln) {
      return sendError(res, 400, 'first_name and last_name cannot be empty.');
    }
    if (!phone) {
      return sendError(res, 400, 'phone_number cannot be empty.');
    }
    const fullName = `${fn} ${ln}`;
    const profileUrl =
      profile_picture !== undefined && profile_picture !== null && String(profile_picture).trim()
        ? String(profile_picture).trim()
        : null;
    const dobValue = employeeDobParsed.value;

    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users
       SET full_name = $1,
           phone_number = $2,
           dob = $3::date,
           profile_picture_url = COALESCE($4, profile_picture_url),
           password_hash = $5,
           company_id = $6,
           is_active = true,
           signup_type = 'email',
           updated_at = NOW()
       WHERE id = $7`,
      [fullName, phone, dobValue, profileUrl, password_hash, parsedCompanyId, u.id]
    );

    const updated = await loadUserRowById(u.id);
    const userDto = formatAuthUser(updated);
    return sendSuccess(res, 200, 'Employee profile created successfully.', {
      user: userDto,
      company_id: updated.company_id ?? null,
    });
  } catch (error) {
    console.error('createEmployeeProfile error:', error);
    return sendError(res, 500, 'Something went wrong while saving your profile.');
  }
}

/**
 * POST /api/v1/auth/employee/register
 * Public self-registration for employees.
 * Body: email, name
 */
async function registerEmployee(req, res) {
  const { email, name } = req.body || {};

  if (!email) {
    return sendError(res, 400, 'Please provide email.');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const fullName =
    name !== undefined && name !== null && String(name).trim()
      ? String(name).trim()
      : normalizedEmail.split('@')[0] || 'Employee';

  try {
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existingUser.rowCount > 0) {
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const otp_code = generateOtp();
    const otp_expires_at = buildOtpExpiryTime();

    const result = await pool.query(
      `INSERT INTO users
      (company_id, employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
       otp_code, otp_expires_at, signup_type, mfa_enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, false, $7, $8, 'email', false, NOW(), NOW())
      RETURNING ${USER_ROW_SQL}`,
      [
        null,
        null,
        fullName,
        normalizedEmail,
        '',
        USER_ROLES.EMPLOYEE,
        otp_code,
        otp_expires_at,
      ]
    );

    const row = result.rows[0];

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendOtpEmail(normalizedEmail, otp_code);
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for OTP (${normalizedEmail}): ${emailResult.reason}`);
    }

    const userDto = formatAuthUser(row);
    const msg = emailResult.sent
      ? 'Employee registered successfully. OTP sent to your email.'
      : 'Employee registered successfully. OTP sent to your email';

    return sendSuccess(res, 201, msg, {
      user: userDto,
      otp: otp_code,
      company_id: row.company_id ?? null,
    });
  } catch (error) {
    console.error('Employee register error:', error);
    return sendError(res, 500, 'Something went wrong while creating your account.');
  }
}

/**
 * POST /api/v1/auth/company-admin/register
 * Public self-registration for company admins.
 * Body: email, password, role? (if provided, must be company_admin)
 */
async function registerCompanyAdmin(req, res) {
  const { email, password, role } = req.body || {};

  if (!email || !password) {
    return sendError(res, 400, 'Please provide email and password.');
  }

  if (role !== undefined && String(role).trim() !== USER_ROLES.COMPANY_ADMIN) {
    return sendError(
      res,
      400,
      'Invalid role. Company Admin registration requires role "company_admin".'
    );
  }

  if (!PASSWORD_REGEX.test(password)) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  // Name is captured in complete profile flow, but DB requires non-null full_name.
  const fullName = 'Pending Profile';

  try {
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existingUser.rowCount > 0) {
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const password_hash = await bcrypt.hash(password, 10);
    const otp_code = generateOtp();
    const otp_expires_at = buildOtpExpiryTime();

    const result = await pool.query(
      `INSERT INTO users
      (company_id, employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
       otp_code, otp_expires_at, signup_type, mfa_enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, false, $7, $8, 'email', false, NOW(), NOW())
      RETURNING ${USER_ROW_SQL}`,
      [
        null,
        null,
        fullName,
        normalizedEmail,
        password_hash,
        USER_ROLES.COMPANY_ADMIN,
        otp_code,
        otp_expires_at,
      ]
    );

    const row = result.rows[0];

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendOtpEmail(normalizedEmail, otp_code);
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for OTP (${normalizedEmail}): ${emailResult.reason}`);
    }

    const userDto = formatAuthUser(row);
    const msg = emailResult.sent
      ? 'Company Admin registered successfully. OTP sent to your email.'
      : 'Company Admin registered successfully. OTP generated for testing.';

    return sendSuccess(res, 201, msg, {
      user: userDto,
      otp: otp_code,
      company_id: row.company_id ?? null,
    });
  } catch (error) {
    console.error('Company Admin register error:', error);
    return sendError(res, 500, 'Something went wrong while creating your account.');
  }
}

/**
 * POST /api/v1/auth/super-admin/register
 * Body: email, name, password, role — role must be super_admin.
 */
async function registerSuperAdmin(req, res) {
  const { email, name, password, role } = req.body || {};

  if (!email || !password || !name || !role) {
    return sendError(res, 400, 'Please provide email, name, password, and role.');
  }

  if (String(role).trim() !== USER_ROLES.SUPER_ADMIN) {
    return sendError(res, 400, 'Invalid role. Super Admin registration requires role "super_admin".');
  }

  if (!PASSWORD_REGEX.test(password)) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const fullName = String(name).trim();
  if (!fullName) {
    return sendError(res, 400, 'Name cannot be empty.');
  }

  try {
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [
      normalizedEmail,
    ]);

    if (existingUser.rowCount > 0) {
      return sendError(res, 409, 'An account with this email already exists.');
    }

    const password_hash = await bcrypt.hash(password, 10);
    const otp_code = generateOtp();
    const otp_expires_at = buildOtpExpiryTime();

    const result = await pool.query(
      `INSERT INTO users
      (employee_id, full_name, email, password_hash, role, is_active, is_email_verified,
       otp_code, otp_expires_at, signup_type, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, true, false, $6, $7, 'email', NOW(), NOW())
      RETURNING ${USER_ROW_SQL}`,
      [null, fullName, normalizedEmail, password_hash, USER_ROLES.SUPER_ADMIN, otp_code, otp_expires_at]
    );

    const row = result.rows[0];

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      emailResult = await sendOtpEmail(normalizedEmail, otp_code);
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for OTP (${normalizedEmail}): ${emailResult.reason}`);
    }

    const userDto = formatAuthUser(row);
    const msg =
      emailResult.sent
        ? 'Super Admin registered successfully. OTP sent to your email.'
        : 'Super Admin registered successfully. OTP generated for testing.';

    return sendSuccess(res, 201, msg, {
      user: userDto,
      otp: otp_code,
    });
  } catch (error) {
    console.error('Super Admin register error:', error);
    return sendError(res, 500, 'Something went wrong while creating your account.');
  }
}

/** POST /api/v1/auth/resend-otp — body: { email } */
async function resendOtp(req, res) {
  const { email } = req.body || {};

  if (!email) {
    return sendError(res, 400, 'Please provide an email address.');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const userResult = await pool.query(
      'SELECT id, is_email_verified, company_id FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'No account found with this email.');
    }

    if (userResult.rows[0].is_email_verified) {
      return sendError(res, 400, 'This email is already verified.');
    }

    const otp_code = generateOtp();
    const otp_expires_at = buildOtpExpiryTime();

    await pool.query(
      `UPDATE users
       SET otp_code = $1, otp_expires_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [otp_code, otp_expires_at, userResult.rows[0].id]
    );

    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      const branding = await fetchCompanyBranding(userResult.rows[0].company_id);
      emailResult = await sendOtpEmail(normalizedEmail, otp_code, {
        companyId: userResult.rows[0].company_id,
        ...branding,
      });
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for OTP (${normalizedEmail}): ${emailResult.reason}`);
    }

    const msg = emailResult.sent ? 'OTP sent successfully.' : 'OTP sent successfully.';

    return sendSuccess(res, 200, msg, {
      email: normalizedEmail,
      otp: otp_code,
    });
  } catch (error) {
    console.error('Resend OTP error:', error);
    return sendError(res, 500, 'Something went wrong while sending OTP.');
  }
}

/** POST /api/v1/auth/verify-otp — body: { email, otp } */
async function verifyOtp(req, res) {
  const { email, otp } = req.body || {};

  const otpNormalized = normalizeOtpInput(otp);
  if (!email || !otpNormalized) {
    return sendError(res, 400, 'Please provide email and OTP.');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const result = await pool.query(
      `SELECT id, email, role, company_id, password_hash, otp_code, otp_expires_at
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'No account found with this email.');
    }

    const user = result.rows[0];

    if (!user.otp_code || !user.otp_expires_at) {
      return sendError(res, 400, 'Please request an OTP first.');
    }

    if (new Date(user.otp_expires_at) < new Date()) {
      return sendError(res, 400, 'OTP has expired. Please request a new OTP.');
    }

    const storedOtp = normalizeOtpInput(user.otp_code);
    if (!storedOtp || storedOtp !== otpNormalized) {
      return sendError(res, 400, 'Invalid OTP. Please try again.');
    }

    await pool.query(
      `UPDATE users
       SET is_email_verified = true, otp_code = NULL, otp_expires_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    const updated = await loadUserRowById(user.id);
    const userDto = formatAuthUser(updated);
    let setupToken = null;
    const shouldIssueEmployeeSetupToken =
      (updated.role === USER_ROLES.EMPLOYEE || updated.role === USER_ROLES.DEPARTMENT_MANAGER) &&
      !hasUsablePassword(updated.password_hash);
    const shouldIssueCompanyAdminSetupToken =
      updated.role === USER_ROLES.COMPANY_ADMIN && hasPendingCompanyAdminProfile(updated.full_name);

    if (shouldIssueEmployeeSetupToken || shouldIssueCompanyAdminSetupToken) {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        return sendError(res, 500, 'Server configuration error. Please try again later.');
      }
      const setupPurpose =
        updated.role === USER_ROLES.COMPANY_ADMIN
          ? COMPANY_ADMIN_SETUP_PURPOSE
          : EMPLOYEE_SETUP_PURPOSE;
      setupToken = jwt.sign(
        {
          userId: updated.id,
          email: updated.email,
          role: updated.role,
          companyId: updated.company_id,
          purpose: setupPurpose,
        },
        jwtSecret,
        {
          expiresIn:
            updated.role === USER_ROLES.COMPANY_ADMIN
              ? COMPANY_ADMIN_SETUP_EXPIRES_IN
              : EMPLOYEE_SETUP_EXPIRES_IN,
        }
      );
    }

    return sendSuccess(
      res,
      200,
      setupToken
        ? 'Email verified successfully. Complete your profile using setup_token.'
        : 'Email verified successfully. You can now log in.',
      {
        user: userDto,
        setup_token: setupToken,
        expires_in: setupToken
          ? updated.role === USER_ROLES.COMPANY_ADMIN
            ? COMPANY_ADMIN_SETUP_EXPIRES_IN
            : EMPLOYEE_SETUP_EXPIRES_IN
          : null,
      }
    );
  } catch (error) {
    console.error('Verify OTP error:', error);
    return sendError(res, 500, 'Something went wrong while verifying OTP.');
  }
}


async function forgotPassword(req, res) {
  const { email } = req.body || {};

  if (!email) {
    return sendError(res, 400, "Please provide an email address.");
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();

    const userResult = await pool.query(
      `SELECT id, is_active, company_id
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, "No account found with this email.");
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return sendError(
        res,
        403,
        "Your account is inactive. Please contact support."
      );
    }

    const resetCode = generateOtp();
    const expiresAt = buildOtpExpiryTime();

    await pool.query(
      `UPDATE users
       SET password_reset_code = $1,
           password_reset_expires_at = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [resetCode, expiresAt, user.id]
    );

    let emailResult = {
      sent: false,
      reason: "unknown error",
    };

    try {
      emailResult = await sendPasswordResetCodeEmail(
        normalizedEmail,
        resetCode,
        {
          companyId: user.company_id,
        }
      );
    } catch (mailError) {
      console.error("Forgot password email error:", mailError);
      emailResult = {
        sent: false,
        reason: mailError.message,
      };
    }

    if (!emailResult.sent) {
      console.error(`Email failed for password reset code (${normalizedEmail}): ${emailResult.reason}`);
    }

    const msg = emailResult.sent
      ? "Password reset code sent to your email."
      : "Password reset code generated for testing.";

    return sendSuccess(res, 200, msg, {
      email: normalizedEmail,
      code: resetCode,
      code_expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("Forgot password error:", error);

    return sendError(
      res,
      500,
      "Something went wrong while processing forgot password."
    );
  }
}

/** POST /api/v1/auth/resend-reset-code — body: { email } */
async function resendResetCode(req, res) {
  const { email } = req.body || {};

  if (!email) {
    return sendError(res, 400, 'Please provide an email address.');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();

    const userResult = await pool.query(
      `SELECT id, is_active, company_id
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'No account found with this email.');
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    const resetCode = generateOtp();
    const expiresAt = buildOtpExpiryTime();

    await pool.query(
      `UPDATE users
       SET password_reset_code = $1,
           password_reset_expires_at = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [resetCode, expiresAt, user.id]
    );

    let emailResult = {
      sent: false,
      reason: 'unknown error',
    };

    try {
      emailResult = await sendPasswordResetCodeEmail(
        normalizedEmail,
        resetCode,
        {
          companyId: user.company_id,
        }
      );
    } catch (mailError) {
      console.error('Resend reset code email error:', mailError);
      emailResult = {
        sent: false,
        reason: mailError.message,
      };
    }

    if (!emailResult.sent) {
      console.error(`Email failed for password reset code (${normalizedEmail}): ${emailResult.reason}`);
    }

    const msg = emailResult.sent
      ? 'Password reset code resent to your email.'
      : 'Password reset code regenerated for testing.';

    const responseData = {
      email: normalizedEmail,
    };

    if (process.env.NODE_ENV !== 'production') {
      responseData.code = resetCode;
      responseData.code_expires_at = expiresAt.toISOString();
    }

    return sendSuccess(res, 200, msg, responseData);
  } catch (error) {
    console.error('Resend reset code error:', error);
    return sendError(res, 500, 'Something went wrong while resending the reset code.');
  }
}

/** POST /api/v1/auth/verify-reset-code */
async function verifyResetCode(req, res) {
  const { email, code, otp } = req.body || {};
  const rawCode = code ?? otp;
  const codeNormalized = normalizeOtpInput(rawCode);

  if (!email || !codeNormalized) {
    return sendError(res, 400, 'Please provide email and reset code.');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const result = await pool.query(
      `SELECT id, email, is_active, password_reset_code, password_reset_expires_at
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'No account found with this email.');
    }

    const user = result.rows[0];
    if (!user.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    if (!user.password_reset_code || !user.password_reset_expires_at) {
      return sendError(res, 400, 'Please request a password reset code first.');
    }

    if (new Date(user.password_reset_expires_at) < new Date()) {
      return sendError(res, 400, 'Reset code has expired. Please request a new one.');
    }

    const stored = normalizeOtpInput(user.password_reset_code);
    if (!stored || stored !== codeNormalized) {
      return sendError(res, 400, 'Invalid reset code. Please try again.');
    }

    const resetToken = issuePasswordResetToken(user);

    return sendSuccess(res, 200, 'Reset code verified successfully. Continue to set a new password.', {
      email: normalizedEmail,
      reset_token: resetToken,
      expires_in: PASSWORD_RESET_EXPIRES_IN,
    });
  } catch (error) {
    console.error('Verify reset code error:', error);
    return sendError(res, 500, 'Something went wrong while verifying the reset code.');
  }
}

/** POST /api/v1/auth/reset-password — Body: email, code (or otp), newPassword OR reset_token/resetToken/token, newPassword */
async function resetPassword(req, res) {
  const { email, newPassword, code, otp, reset_token, resetToken, token } = req.body || {};
  const rawCode = code ?? otp;
  const codeNormalized = normalizeOtpInput(rawCode);
  const providedToken = reset_token ?? resetToken ?? token;

  if (!newPassword) {
    return sendError(res, 400, 'Please provide newPassword.');
  }

  if (!providedToken && (!email || !codeNormalized)) {
    return sendError(res, 400, 'Please provide a reset token or email and reset code.');
  }

  if (!PASSWORD_REGEX.test(newPassword)) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  try {
    let user;
    let normalizedEmail;

    if (providedToken) {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        return sendError(res, 500, 'Server configuration error. Please try again later.');
      }

      let decoded;
      try {
        decoded = jwt.verify(providedToken, jwtSecret);
      } catch (tokenError) {
        return sendError(res, 401, 'Invalid or expired reset token. Please request a new one.');
      }

      if (decoded.purpose !== PASSWORD_RESET_PURPOSE) {
        return sendError(res, 401, 'Invalid reset token.');
      }

      normalizedEmail = String(decoded.email).toLowerCase().trim();
      const result = await pool.query(
        `SELECT id, email, role, is_active, company_id
         FROM users
         WHERE id = $1 AND email = $2`,
        [decoded.userId, normalizedEmail]
      );

      if (result.rowCount === 0) {
        return sendError(res, 404, 'User not found.');
      }

      user = result.rows[0];
    } else {
      normalizedEmail = String(email).toLowerCase().trim();
      const result = await pool.query(
        `SELECT id, is_active, password_reset_code, password_reset_expires_at, company_id
         FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      if (result.rowCount === 0) {
        return sendError(res, 404, 'No account found with this email.');
      }

      user = result.rows[0];
      if (!user.is_active) {
        return sendError(res, 403, 'Your account is inactive. Please contact support.');
      }

      if (!user.password_reset_code || !user.password_reset_expires_at) {
        return sendError(res, 400, 'Please request a password reset code first.');
      }

      if (new Date(user.password_reset_expires_at) < new Date()) {
        return sendError(res, 400, 'Reset code has expired. Please request a new one.');
      }

      const stored = normalizeOtpInput(user.password_reset_code);
      if (!stored || stored !== codeNormalized) {
        return sendError(res, 400, 'Invalid reset code. Please try again.');
      }
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           password_reset_code = NULL,
           password_reset_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [password_hash, user.id]
    );

    try {
      await sendResetPasswordEmail(normalizedEmail || user.email, {
        companyId: user.company_id,
      });
    } catch (mailError) {
      console.error('Password changed email error:', mailError);
    }

    return sendSuccess(
      res,
      200,
      'Password reset successful. You can now log in with your new password.'
    );
  } catch (error) {
    console.error('Reset password error:', error);
    return sendError(res, 500, 'Something went wrong while resetting password.');
  }
}

/** POST /api/v1/auth/change-password — Authorization: Bearer access_token */
async function changePassword(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const { current_password, currentPassword, new_password, newPassword } = req.body || {};
  const currentPasswordValue =
    current_password !== undefined ? current_password : currentPassword;
  const newPasswordValue = new_password !== undefined ? new_password : newPassword;

  if (!currentPasswordValue || !newPasswordValue) {
    return sendError(res, 400, 'Please provide current_password and new_password.');
  }

  if (!PASSWORD_REGEX.test(String(newPasswordValue))) {
    return sendError(
      res,
      400,
      'Password must be at least 8 characters long and include uppercase, lowercase, and a special character.'
    );
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return sendError(res, 500, 'Server configuration error. Please try again later.');
    }

    let decodedToken;
    try {
      decodedToken = jwt.verify(token, jwtSecret);
    } catch (tokenError) {
      return sendError(res, 401, 'Invalid or expired token.');
    }

    if (decodedToken.purpose) {
      return sendError(res, 401, 'Use a login access token for this endpoint.');
    }

    const userResult = await pool.query(
      `SELECT id, email, role, is_active, password_hash, company_id
       FROM users
       WHERE id = $1 AND email = $2`,
      [decodedToken.userId, decodedToken.email]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }

    const user = userResult.rows[0];
    if (!user.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    if (!hasUsablePassword(user.password_hash)) {
      return sendError(res, 400, 'Current password is not set for this account.');
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      String(currentPasswordValue),
      user.password_hash
    );
    if (!isCurrentPasswordValid) {
      return sendError(res, 401, 'Current password is incorrect.');
    }

    const isSameAsCurrent = await bcrypt.compare(String(newPasswordValue), user.password_hash);
    if (isSameAsCurrent) {
      return sendError(res, 400, 'New password must be different from current password.');
    }

    const password_hash = await bcrypt.hash(String(newPasswordValue), 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [password_hash, user.id]
    );

    try {
      await sendPasswordChangedEmail(user.email, {
        companyId: user.company_id,
      });
    } catch (mailError) {
      console.error('Password changed email error:', mailError);
    }

    return sendSuccess(res, 200, 'Password changed successfully.', {
      role: user.role,
    });
  } catch (error) {
    console.error('Change password error:', error);
    return sendError(res, 500, 'Something went wrong while changing password.');
  }
}

async function login(req, res) {
  const { email, password, device_id, deviceId, fcm_token, fcmToken, platform, device_label, deviceLabel } =
    req.body || {};

  if (!email || !password) {
    return sendError(res, 400, 'Please provide email and password.');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const result = await pool.query(`SELECT ${USER_ROW_SQL} FROM users WHERE email = $1`, [
      normalizedEmail,
    ]);

    if (result.rowCount === 0) {
      return sendError(res, 401, 'Invalid email or password.');
    }

    const user = result.rows[0];

    if (isEmployeeAwaitingVerification(user)) {
      return sendError(
        res,
        403,
        'You must verify your account before logging in. Please check your email for the verification OTP.',
        { code: 'account_not_verified', verification_method: 'otp' }
      );
    }

    if (isEmployeePasswordNotSet(user)) {
      return sendError(
        res,
        403,
        'You have not set your password yet. Please use the password set link sent to your email.',
        { code: 'password_not_set' }
      );
    }

    if (!user.is_email_verified) {
      return sendError(res, 403, 'Please verify your email before logging in.', {
        code: 'email_not_verified',
      });
    }

    if (!hasUsablePassword(user.password_hash)) {
      return sendError(res, 403, 'Please complete your account setup before logging in.', {
        code: 'setup_incomplete',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return sendError(res, 401, 'Invalid email or password.');
    }

    if (isEmployeePendingApproval(user)) {
      return sendError(
        res,
        403,
        'Your account is pending approval from your company administrator.',
        { code: 'pending_approval' }
      );
    }

    if (!user.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    const userDto = formatAuthUser(user);
    const msg = loginSuccessMessageEn(user.role);
    const isEmployee = isEmployeeRole(user.role);

    // Independent lookups (token issuance, permissions, device sync, and — for employees — the
    // LMS gate flags) all run concurrently instead of one round trip at a time. Fetching
    // lms_required/lms_completed_at here means the front-end can decide the LMS gate right off
    // the login response, without a second /auth/profile round trip just to unblock the shell.
    const [tokenPayload, permPayload, deviceSync, lmsResult] = await Promise.all([
      issueAccessToken(user),
      buildAuthPermissionPayload(user),
      deviceTokenService.handleLoginDeviceSync(user.id, {
        device_id: device_id ?? deviceId,
        fcm_token: fcm_token ?? fcmToken,
        platform,
        device_label: device_label ?? deviceLabel,
      }),
      isEmployee && user.employee_id
        ? pool.query(`SELECT lms_required, lms_completed_at FROM employees WHERE id = $1`, [
            user.employee_id,
          ])
        : Promise.resolve(null),
    ]);

    if (tokenPayload.error) {
      return sendError(res, 500, tokenPayload.error);
    }

    if (deviceSync.error) {
      return sendError(res, deviceSync.status || 400, deviceSync.error);
    }

    const lmsRow = lmsResult?.rows?.[0] || null;

    return sendSuccess(res, 200, msg, {
      ...tokenPayload,
      user: {
        ...userDto,
        access_role_id: permPayload.access_role_id,
        access_role_name: permPayload.access_role_name,
        ...(isEmployee
          ? {
              lms_required: lmsRow?.lms_required === true,
              lms_completed_at: lmsRow?.lms_completed_at ?? null,
            }
          : {}),
      },
      permissions: permPayload.permissions,
      device: deviceSync.data || null,
    });
  } catch (error) {
    console.error('Login error:', error);
    return sendError(res, 500, 'Something went wrong while logging in.');
  }
}

async function getProfile(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return sendError(res, 500, 'Server configuration error. Please try again later.');
    }

    let decodedToken;
    try {
      decodedToken = jwt.verify(token, jwtSecret);
    } catch (tokenError) {
      return sendError(res, 401, 'Invalid or expired token.');
    }

    if (decodedToken.purpose) {
      return sendError(res, 401, 'Use a login access token for this endpoint.');
    }

    const userResult = await pool.query(
      `SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`,
      [decodedToken.userId, decodedToken.email]
    );

    if (userResult.rowCount === 0) {
      return sendError(res, 404, 'User not found.');
    }

    let user = userResult.rows[0];
    if (!user.is_active) {
      return sendError(res, 403, 'Your account is inactive. Please contact support.');
    }

    user = await resolveLinkedCompanyForUser(user);

    const userDto = formatAuthUser(user);
    const isEmployee = isEmployeeRole(user.role);

    if (isEmployee && (!user.employee_id || !user.company_id)) {
      return sendError(
        res,
        404,
        'Employee record is not linked to this account. Please contact your company admin.'
      );
    }

    // permissions, the employee profile, the company row, and the line-manager check are all
    // independent lookups keyed off `user` fields already known at this point — run them
    // concurrently instead of one round trip at a time (this used to be the bulk of the
    // remaining /auth/profile latency after buildNestedEmployeePayload was parallelized).
    const [permPayload, employee, company, lineManagerResult] = await Promise.all([
      buildAuthPermissionPayload(user),
      isEmployee
        ? employeeNested.fetchFullEmployeeProfileDetails(pool, {
            employeeId: user.employee_id,
            companyId: user.company_id,
            userRow: user,
          })
        : Promise.resolve(null),
      loadCompanyForProfile(pool, user.company_id, user.role),
      isEmployee
        ? pool.query(
            `SELECT (
               EXISTS (
                 SELECT 1 FROM employee_line_managers elm
                 WHERE elm.company_id = $1 AND elm.manager_id = $2
               )
               OR EXISTS (
                 SELECT 1 FROM department_line_managers dlm
                 WHERE dlm.company_id = $1 AND dlm.employee_id = $2 AND dlm.manager_role = 'head'
               )
               OR EXISTS (
                 SELECT 1 FROM leave_policy_approval_steps s
                 WHERE s.company_id = $1
                   AND (s.approver_user_id = $3 OR s.access_role_id = $4)
               )
               OR EXISTS (
                 SELECT 1 FROM leave_request_approvals lra
                 WHERE lra.company_id = $1 AND lra.status = 'pending'
                   AND (lra.approver_user_id = $3 OR lra.access_role_id = $4)
               )
             ) AS is_line_manager`,
            [user.company_id, user.employee_id, user.id, user.access_role_id]
          )
        : Promise.resolve(null),
    ]);

    if (isEmployee && !employee) {
      return sendError(res, 404, 'Employee record not found.');
    }

    const payload = {
      user: {
        ...userDto,
        access_role_id: permPayload.access_role_id,
        access_role_name: permPayload.access_role_name,
        // Mirrored from employee.* so Redux's authUser (refreshed via updateAuthUser on every
        // profile fetch) stays the front-end's source of truth for the LMS gate — including
        // right after the employee marks training complete and the page calls refetchProfile().
        ...(employee
          ? { lms_required: employee.lms_required === true, lms_completed_at: employee.lms_completed_at ?? null }
          : {}),
      },
      permissions: permPayload.permissions,
      company,
    };
    if (employee) {
      employee.is_line_manager = lineManagerResult.rows[0]?.is_line_manager === true;
      payload.employee = employee;
    }
    return sendSuccess(res, 200, 'Profile fetched successfully.', payload);
  } catch (error) {
    console.error('Get profile error:', error);
    return sendError(res, 500, 'Something went wrong while fetching profile.');
  }
}

function validateProfileUpdateBody(body) {
  const {
    first_name,
    last_name,
    full_name,
    profile_picture,
    phone_number,
    dob,
    gender,
    country,
    current_address,
    permanent_address,
  } = body || {};
  if (
    typeof first_name === 'undefined' &&
    typeof last_name === 'undefined' &&
    typeof full_name === 'undefined' &&
    typeof profile_picture === 'undefined' &&
    typeof phone_number === 'undefined' &&
    typeof dob === 'undefined' &&
    typeof gender === 'undefined' &&
    typeof country === 'undefined' &&
    typeof current_address === 'undefined' &&
    typeof permanent_address === 'undefined'
  ) {
    return {
      error: {
        status: 400,
        message:
          'Please provide at least one field to update: first_name, last_name, full_name, profile_picture, phone_number, dob, gender, country, current_address, or permanent_address.',
      },
    };
  }

  if (typeof first_name !== 'undefined' && !String(first_name).trim()) {
    return { error: { status: 400, message: 'first_name cannot be empty.' } };
  }
  if (typeof last_name !== 'undefined' && !String(last_name).trim()) {
    return { error: { status: 400, message: 'last_name cannot be empty.' } };
  }
  if (typeof full_name !== 'undefined' && !String(full_name).trim()) {
    return { error: { status: 400, message: 'full_name cannot be empty.' } };
  }
  if (typeof profile_picture !== 'undefined' && !String(profile_picture).trim()) {
    return { error: { status: 400, message: 'profile_picture cannot be empty.' } };
  }
  if (typeof phone_number !== 'undefined' && !String(phone_number).trim()) {
    return { error: { status: 400, message: 'phone_number cannot be empty.' } };
  }
  if (typeof gender !== 'undefined') {
    const normalizedGender = String(gender).trim().toLowerCase();
    if (!normalizedGender) {
      return { error: { status: 400, message: 'gender cannot be empty.' } };
    }
    if (!PROFILE_GENDERS.has(normalizedGender)) {
      return { error: { status: 400, message: 'gender must be male, female, or other.' } };
    }
  }
  if (typeof country !== 'undefined' && !String(country).trim()) {
    return { error: { status: 400, message: 'country cannot be empty.' } };
  }

  const dobParsed =
    typeof dob !== 'undefined' ? parseOptionalDateInput(dob, 'dob') : { value: undefined };
  if (dobParsed.error) {
    return { error: { status: 400, message: dobParsed.error } };
  }

  return {
    fields: {
      first_name,
      last_name,
      full_name,
      profile_picture,
      phone_number,
      dob,
      gender:
        typeof gender !== 'undefined' ? String(gender).trim().toLowerCase() : undefined,
      country: typeof country !== 'undefined' ? String(country).trim().toUpperCase() : undefined,
      current_address:
        typeof current_address !== 'undefined' ? String(current_address).trim() : undefined,
      permanent_address:
        typeof permanent_address !== 'undefined' ? String(permanent_address).trim() : undefined,
    },
    dobValue: dobParsed.value,
  };
}

function resolveProfileNameUpdates(user, fields) {
  const { first_name, last_name, full_name } = fields;
  let resolvedFullName;

  if (typeof first_name !== 'undefined' || typeof last_name !== 'undefined') {
    const currentName = splitFullName(user.full_name);
    const fn = typeof first_name !== 'undefined' ? String(first_name).trim() : currentName.first_name;
    const ln = typeof last_name !== 'undefined' ? String(last_name).trim() : currentName.last_name;
    if (!fn || !ln) {
      return { error: { status: 400, message: 'first_name and last_name cannot be empty.' } };
    }
    resolvedFullName = `${fn} ${ln}`;
  } else if (typeof full_name !== 'undefined') {
    resolvedFullName = String(full_name).trim();
  }

  return { resolvedFullName };
}

async function persistUserProfileUpdates(userId, { resolvedFullName, profilePictureValue, phoneValue, dobValue }) {
  if (resolvedFullName) {
    await pool.query(`UPDATE users SET full_name = $1, updated_at = NOW() WHERE id = $2`, [
      resolvedFullName,
      userId,
    ]);
  }

  if (profilePictureValue !== undefined) {
    await pool.query(`UPDATE users SET profile_picture_url = $1, updated_at = NOW() WHERE id = $2`, [
      profilePictureValue,
      userId,
    ]);
  }

  if (phoneValue !== undefined) {
    await pool.query(`UPDATE users SET phone_number = $1, updated_at = NOW() WHERE id = $2`, [
      phoneValue,
      userId,
    ]);
  }

  if (dobValue !== undefined) {
    await pool.query(`UPDATE users SET dob = $1::date, updated_at = NOW() WHERE id = $2`, [
      dobValue,
      userId,
    ]);
  }
}

async function persistEmployeeProfileUpdates(user, fields, { resolvedFullName, profilePictureValue, phoneValue, dobValue }) {
  if (!isEmployeeRole(user.role)) return;

  if (!user.employee_id || !user.company_id) {
    const error = new Error('employee_not_linked');
    error.status = 404;
    error.message =
      'Employee record is not linked to this account. Please contact your company admin.';
    throw error;
  }

  const { first_name, last_name, gender, country, current_address, permanent_address } = fields;
  const employeeSets = [];
  const employeeParams = [];
  let employeeParamIndex = 1;

  if (resolvedFullName) {
    const { first_name: empFirst, last_name: empLast } = splitFullName(resolvedFullName);
    employeeSets.push(`first_name = $${employeeParamIndex++}`);
    employeeParams.push(empFirst);
    employeeSets.push(`last_name = $${employeeParamIndex++}`);
    employeeParams.push(empLast);
  } else {
    if (typeof first_name !== 'undefined') {
      employeeSets.push(`first_name = $${employeeParamIndex++}`);
      employeeParams.push(String(first_name).trim());
    }
    if (typeof last_name !== 'undefined') {
      employeeSets.push(`last_name = $${employeeParamIndex++}`);
      employeeParams.push(String(last_name).trim());
    }
  }

  if (profilePictureValue !== undefined) {
    employeeSets.push(`profile_picture_url = $${employeeParamIndex++}`);
    employeeParams.push(profilePictureValue);
  }

  if (phoneValue !== undefined) {
    employeeSets.push(`home_phone = $${employeeParamIndex++}`);
    employeeParams.push(phoneValue);
  }

  if (dobValue !== undefined) {
    employeeSets.push(`dob = $${employeeParamIndex++}::date`);
    employeeParams.push(dobValue);
  }

  if (typeof gender !== 'undefined') {
    employeeSets.push(`gender = $${employeeParamIndex++}`);
    employeeParams.push(String(gender).trim().toLowerCase());
  }

  if (typeof country !== 'undefined') {
    employeeSets.push(`country = $${employeeParamIndex++}`);
    employeeParams.push(String(country).trim().toUpperCase());
  }

  if (typeof current_address !== 'undefined') {
    employeeSets.push(`temporary_address = $${employeeParamIndex++}`);
    employeeParams.push(String(current_address).trim());
  }

  if (typeof permanent_address !== 'undefined') {
    employeeSets.push(`permanent_address = $${employeeParamIndex++}`);
    employeeParams.push(String(permanent_address).trim());
  }

  if (employeeSets.length === 0) return;

  employeeParams.push(user.employee_id, user.company_id);
  await pool.query(
    `UPDATE employees
     SET ${employeeSets.join(', ')}
     WHERE id = $${employeeParamIndex++} AND company_id = $${employeeParamIndex}`,
    employeeParams
  );
}

async function buildProfilePayloadForUser(userRow) {
  const userDto = formatAuthUser(userRow);
  let employee = null;

  if (isEmployeeRole(userRow.role)) {
    employee = await employeeNested.fetchFullEmployeeProfileDetails(pool, {
      employeeId: userRow.employee_id,
      companyId: userRow.company_id,
      userRow,
    });

    if (!employee) {
      const error = new Error('employee_not_found');
      error.status = 404;
      error.message = 'Employee record not found.';
      throw error;
    }
  }

  const company = await loadCompanyForProfile(pool, userRow.company_id, userRow.role);
  const payload = { user: userDto, company };
  if (employee) {
    payload.employee = employee;
  }
  return payload;
}

/** Backfill users.company_id from employees when the link is missing (legacy data). */
async function resolveLinkedCompanyForUser(user) {
  if (!user || user.company_id || !user.employee_id) {
    return user;
  }

  const employeeResult = await pool.query(`SELECT company_id FROM employees WHERE id = $1`, [
    user.employee_id,
  ]);

  const companyId = employeeResult.rows[0]?.company_id ?? null;
  if (!companyId) {
    return user;
  }

  await pool.query(`UPDATE users SET company_id = $1, updated_at = NOW() WHERE id = $2 AND company_id IS NULL`, [
    companyId,
    user.id,
  ]);

  return { ...user, company_id: companyId };
}

async function loadActiveUserFromAuthClaims(userId, email) {
  const userResult = await pool.query(`SELECT ${USER_ROW_SQL} FROM users WHERE id = $1 AND email = $2`, [
    userId,
    email,
  ]);

  if (userResult.rowCount === 0) {
    return { error: { status: 404, message: 'User not found.' } };
  }

  let user = userResult.rows[0];
  if (!user.is_active) {
    return { error: { status: 403, message: 'Your account is inactive. Please contact support.' } };
  }

  user = await resolveLinkedCompanyForUser(user);
  return { user };
}

async function executeProfileUpdate(user, body, { syncEmployee = false } = {}) {
  const linkedUser = await resolveLinkedCompanyForUser(user);
  const validation = validateProfileUpdateBody(body);
  if (validation.error) {
    return { error: validation.error };
  }

  const nameResult = resolveProfileNameUpdates(linkedUser, validation.fields);
  if (nameResult.error) {
    return { error: nameResult.error };
  }

  const profilePictureValue =
    typeof validation.fields.profile_picture !== 'undefined'
      ? String(validation.fields.profile_picture).trim()
      : undefined;
  const phoneValue =
    typeof validation.fields.phone_number !== 'undefined'
      ? String(validation.fields.phone_number).trim()
      : undefined;
  const dobValue = validation.dobValue;

  try {
    await persistUserProfileUpdates(linkedUser.id, {
      resolvedFullName: nameResult.resolvedFullName,
      profilePictureValue,
      phoneValue,
      dobValue,
    });
  } catch (dbError) {
    console.error('persistUserProfileUpdates error:', dbError);
    return {
      error: {
        status: 500,
        message: dbError.message || 'Failed to update user profile.',
      },
    };
  }

  if (syncEmployee) {
    try {
      await persistEmployeeProfileUpdates(linkedUser, validation.fields, {
        resolvedFullName: nameResult.resolvedFullName,
        profilePictureValue,
        phoneValue,
        dobValue,
      });
    } catch (employeeError) {
      return {
        error: {
          status: employeeError.status || 500,
          message: employeeError.message || 'Failed to update employee profile.',
        },
      };
    }
  }

  const updated = await resolveLinkedCompanyForUser(await loadUserRowById(linkedUser.id));
  try {
    const payload = await buildProfilePayloadForUser(updated);
    return { payload };
  } catch (profileError) {
    return {
      error: {
        status: profileError.status || 500,
        message: profileError.message || 'Failed to load updated profile.',
      },
    };
  }
}


async function updateProfile(req, res) {

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return sendError(res, 401, "Authorization token is required.");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return sendError(res, 401, "Authorization token is required.");
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      return sendError(
        res,
        500,
        "Server configuration error. Please try again later."
      );
    }

    let decodedToken;

    try {
      decodedToken = jwt.verify(token, jwtSecret);
    } catch (tokenError) {
      return sendError(res, 401, "Invalid or expired token.");
    }

    if (decodedToken.purpose) {
      return sendError(
        res,
        401,
        "Use a login access token for this endpoint."
      );
    }

    const loaded = await loadActiveUserFromAuthClaims(
      decodedToken.userId,
      decodedToken.email
    );

    if (loaded.error) {
      return sendError(
        res,
        loaded.error.status,
        loaded.error.message
      );
    }


    const result = await executeProfileUpdate(loaded.user, req.body, {
      syncEmployee: isEmployeeRole(loaded.user.role),
    });

    if (result.error) {
      return sendError(
        res,
        result.error.status,
        result.error.message
      );
    }

    return sendSuccess(
      res,
      200,
      "Profile updated successfully.",
      result.payload
    );
  } catch (error) {
    console.error("Update profile error:", error);

    return sendError(
      res,
      500,
      "Something went wrong while updating profile."
    );
  }
}
/** PATCH /api/v1/auth/company-admin/profile */
async function updateCompanyAdminProfile(req, res) {
  if (req.authUser?.purpose) {
    return sendError(res, 401, 'Use a login access token for this endpoint.');
  }

  try {
    const loaded = await loadActiveUserFromAuthClaims(req.authUser.userId, req.authUser.email);
    if (loaded.error) {
      return sendError(res, loaded.error.status, loaded.error.message);
    }

    if (loaded.user.role !== USER_ROLES.COMPANY_ADMIN) {
      return sendError(res, 403, 'Only a Company Admin can update this profile.');
    }

    const result = await executeProfileUpdate(loaded.user, req.body, { syncEmployee: false });
    if (result.error) {
      return sendError(res, result.error.status, result.error.message);
    }

    return sendSuccess(res, 200, 'Company admin profile updated successfully.', result.payload);
  } catch (error) {
    console.error('Update company admin profile error:', error);
    return sendError(res, 500, 'Something went wrong while updating profile.');
  }
}

/** PATCH /api/v1/auth/employee/profile */
async function updateEmployeeProfile(req, res) {
  if (req.authUser?.purpose) {
    return sendError(res, 401, 'Use a login access token for this endpoint.');
  }

  try {
    const loaded = await loadActiveUserFromAuthClaims(req.authUser.userId, req.authUser.email);
    if (loaded.error) {
      return sendError(res, loaded.error.status, loaded.error.message);
    }

    if (!isEmployeeRole(loaded.user.role)) {
      return sendError(res, 403, 'Only an employee can update this profile.');
    }

    const result = await executeProfileUpdate(loaded.user, req.body, { syncEmployee: true });
    if (result.error) {
      return sendError(res, result.error.status, result.error.message);
    }
   

    return sendSuccess(res, 200, 'Employee profile updated successfully.', result.payload);
  } catch (error) {
    console.error('Update employee profile error:', error);
    return sendError(res, 500, 'Something went wrong while updating profile.');
  }
}

module.exports = {
  registerCompanyAdmin,
  registerEmployee,
  registerSuperAdmin,
  createCompanyAdminInvite,
  verifyCompanyAdminAccount,
  createCompanyAdminProfile,
  createCompanyWithSetupToken,
  createEmployeeInvite,
  verifyEmployeeAccount,
  resendEmployeeInvite,
  resendEmployeePasswordSetLink,
  setEmployeePassword,
  createEmployeeProfile,
  resendOtp,
  verifyOtp,
  verifyResetCode,
  resendResetCode,
  forgotPassword,
  resetPassword,
  changePassword,
  login,
  getProfile,
  updateProfile,
  updateCompanyAdminProfile,
  updateEmployeeProfile,
};
