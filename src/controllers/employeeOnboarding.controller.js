const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { USER_ROLES } = require('../constants/userRoles');
const {
  ONBOARDING_TOKEN_PURPOSE,
  ONBOARDING_INVITE_EXPIRES_IN,
  ONBOARDING_INVITE_EXPIRES_MINUTES,
  ONBOARDING_STATUSES,
} = require('../constants/onboarding');
const employeeNested = require('../services/employeeNested.service');
const dependantsController = require('./dependants.controller');
const dependantRelationshipTypesController = require('./dependantRelationshipTypes.controller');
const lineManagerService = require('../services/lineManager.service');
const { grantActivePolicyBalancesForEmployee } = require('../services/leaveBalance.service');
const { fetchCompanyBranding } = require('../utils/companyBranding');
const { requireE164 } = require('../utils/phoneValidation');
const { parseOptionalDateInput, utcNowForPgTimestamp, toUtcIsoString } = require('../utils/dateTime');
const {
  sendEmployeeOnboardingInviteEmail,
  sendEmployeeOnboardingSubmittedEmail,
  sendEmployeeOnboardingDocumentRejectedEmail,
  sendEmployeeOnboardingResendRequestedEmail,
  sendEmployeeTemporaryCredentialsEmail,
} = require('../services/email.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%';
const MARITAL_STATUSES = new Set(['Single', 'Married', 'Divorced', 'Widowed', 'Separated']);
const PROFILE_GENDERS = new Set(['male', 'female', 'other']);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** BIGINT from node-pg — JSON-safe number (or string if out of safe range). */
function serializeRowId(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'bigint') {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val.toString();
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : String(val);
}

function generateOnboardingTemporaryPassword() {
  const random = Array.from(crypto.randomBytes(10), (byte) => PASSWORD_CHARS[byte % PASSWORD_CHARS.length]).join('');
  return `Aa1@${random}`;
}

function buildOnboardingInviteUrl(token) {
  const base =
    process.env.ONBOARDING_INVITE_URL ||
    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/onboarding`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

function signOnboardingToken(employeeId, companyId) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return null;
  return jwt.sign(
    { employeeId, companyId, purpose: ONBOARDING_TOKEN_PURPOSE },
    jwtSecret,
    { expiresIn: ONBOARDING_INVITE_EXPIRES_IN }
  );
}

async function sendOnboardingInviteEmailSafe({ toEmail, companyId, employeeName, onboardingUrl }) {
  let emailResult = { sent: false, reason: 'unknown error' };
  try {
    const branding = await fetchCompanyBranding(companyId);
    emailResult = await sendEmployeeOnboardingInviteEmail(toEmail, onboardingUrl, {
      companyId,
      employeeName,
      ...branding,
    });
  } catch (mailError) {
    emailResult = { sent: false, reason: mailError.message };
  }
  if (!emailResult.sent) {
    console.error(`Email failed for onboarding invite (${toEmail}): ${emailResult.reason}`);
  }
  return emailResult;
}

// ---------------------------------------------------------------------------
// Shared read helpers (used by both the admin review screen and the
// employee's own "me" endpoints so the two stay in sync).
// ---------------------------------------------------------------------------

async function fetchOnboardingDocumentsChecklist(db, employeeId, companyId) {
  const result = await db.query(
    `SELECT dt.id AS document_type_id, dt.label, dt.value, dt.is_mandatory,
            od.id AS onboarding_document_id, od.file_url, od.file_name, od.status,
            od.skip_reason, od.rejection_reason, od.reviewed_at
     FROM document_types dt
     LEFT JOIN onboarding_documents od ON od.document_type_id = dt.id AND od.employee_id = $1
     WHERE dt.company_id = $2
     ORDER BY dt.is_mandatory DESC, dt.label ASC`,
    [employeeId, companyId]
  );
  return result.rows.map((row) => ({
    document_type_id: serializeRowId(row.document_type_id),
    label: row.label,
    value: row.value,
    is_mandatory: row.is_mandatory,
    onboarding_document_id: serializeRowId(row.onboarding_document_id),
    file_url: row.file_url,
    file_name: row.file_name,
    status: row.status || 'not_submitted',
    skip_reason: row.skip_reason,
    rejection_reason: row.rejection_reason,
    reviewed_at: toUtcIsoString(row.reviewed_at),
  }));
}

/**
 * Shared by the single-document endpoint (POST /me/documents) and the unified
 * profile update (PATCH /me, documents[] array) so both go through identical
 * validation/upsert logic against onboarding_documents (approval workflow table —
 * distinct from employee_documents used by Add/Update Employee).
 */
async function upsertOnboardingDocumentRow(db, employeeId, companyId, doc) {
  const documentTypeId = parsePositiveInt(doc?.document_type_id);
  if (!documentTypeId) return { error: 'document_type_id must be a positive integer.' };

  const isSkip = Boolean(doc.skip);
  let fileUrl = null;
  let fileName = null;
  let skipReason = null;

  if (isSkip) {
    skipReason = String(doc.skip_reason || '').trim();
    if (!skipReason) return { error: 'skip_reason is required when skipping a document.' };
  } else {
    fileUrl = doc.file_url ? String(doc.file_url).trim() : '';
    if (!fileUrl) return { error: 'file_url is required.' };
    fileName = doc.file_name ? String(doc.file_name).trim().slice(0, 255) : null;
  }

  const typeCheck = await db.query(`SELECT id FROM document_types WHERE id = $1 AND company_id = $2`, [
    documentTypeId,
    companyId,
  ]);
  if (typeCheck.rowCount === 0) {
    return { error: `Invalid document_type_id: ${documentTypeId} for this company.` };
  }

  const status = isSkip ? 'skipped' : 'pending';
  const result = await db.query(
    `INSERT INTO onboarding_documents (
       employee_id, company_id, document_type_id, file_url, file_name, status, skip_reason,
       rejection_reason, reviewed_by, reviewed_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NOW(), NOW())
     ON CONFLICT (employee_id, document_type_id) DO UPDATE SET
       file_url = EXCLUDED.file_url,
       file_name = EXCLUDED.file_name,
       status = EXCLUDED.status,
       skip_reason = EXCLUDED.skip_reason,
       rejection_reason = NULL,
       reviewed_by = NULL,
       reviewed_at = NULL,
       updated_at = NOW()
     RETURNING id, status`,
    [employeeId, companyId, documentTypeId, fileUrl, fileName, status, skipReason]
  );

  return { onboarding_document_id: serializeRowId(result.rows[0].id), status: result.rows[0].status };
}

/**
 * Reuses the exact same builder Add Employee / Update Employee / Get Employee use
 * (employeeNested.fetchFullEmployeeProfileDetails) so `personal`, `official`, `salary`,
 * `documents`, `dependants`, and `employee_bank` come back with identical attribute names
 * everywhere in the app. Adds the onboarding-only bits (checklist with approval status)
 * on top under `onboarding_documents`, which has no equivalent in the normal employee shape.
 */
async function buildOnboardingProfilePayload(db, employeeId, companyId, userRow = null) {
  const profileDetails = await employeeNested.fetchFullEmployeeProfileDetails(db, {
    employeeId,
    companyId,
    userRow,
  });
  if (!profileDetails) return null;

  const onboardingDocuments = await fetchOnboardingDocumentsChecklist(db, employeeId, companyId);

  return {
    ...profileDetails,
    onboarding_documents: onboardingDocuments,
  };
}

// ---------------------------------------------------------------------------
// Admin (Company Admin / HR) endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/employee-onboarding/invite
 * Accepts the same official-info fields as Add Employee (designation_id, department_id,
 * employee_type_id, work_location_id, shift_id, line_manager_id) plus access_role_id — the
 * permission role, staged on employee_job_details until activateOnboardingEmployee creates
 * the login and copies it onto users.access_role_id. The invited employee can see this role
 * read-only in their onboarding profile (GET /me) but never edit it (PATCH /me doesn't
 * touch official/access_role_id at all).
 */
async function inviteEmployee(req, res) {
  const body = req.body || {};
  const firstName = String(body.first_name || '').trim();
  const lastName = String(body.last_name || '').trim();
  const personalEmail = String(body.personal_email || body.email || '').trim().toLowerCase();
  // work_email is optional at invite time — defaults to personal_email so the employee
  // record always has a usable email (same shape as employees created via Add Employee),
  // and can be overridden here or later at activation with a distinct company address.
  const workEmailInput = body.work_email ? String(body.work_email).trim().toLowerCase() : '';
  if (workEmailInput && !EMAIL_REGEX.test(workEmailInput)) {
    return sendError(res, 400, 'Please provide a valid work_email.');
  }
  const workEmail = workEmailInput || personalEmail;
  const employeeCode = String(body.employee_code || '').trim();

  if (!firstName || firstName.length < 2) {
    return sendError(res, 400, 'first_name is required and must be at least 2 characters.');
  }
  if (!lastName || lastName.length < 2) {
    return sendError(res, 400, 'last_name is required and must be at least 2 characters.');
  }
  if (!personalEmail || !EMAIL_REGEX.test(personalEmail)) {
    return sendError(res, 400, 'Please provide a valid personal_email.');
  }
  if (!employeeCode) {
    return sendError(res, 400, 'employee_code is required.');
  }
  if (employeeCode.length > 50) {
    return sendError(res, 400, 'employee_code must be at most 50 characters.');
  }

  let homePhone = null;
  if (body.phone_number !== undefined && body.phone_number !== null && String(body.phone_number).trim() !== '') {
    const phoneResult = requireE164(body.phone_number, { fieldName: 'phone number' });
    if (phoneResult.error) return sendError(res, 400, phoneResult.error);
    homePhone = phoneResult.e164;
  }

  const joiningDateResult = parseOptionalDateInput(body.joining_date, 'joining_date');
  if (joiningDateResult.error) return sendError(res, 400, joiningDateResult.error);
  const joiningDate = joiningDateResult.value;

  const companyId = req.authUser.companyId;
  if (!companyId) {
    return sendError(res, 400, 'Your account is not linked to any company.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  const client = await pool.connect();
  let employee;
  let onboardingUrl;
  let accessRoleResolved = { id: null, name: null };
  try {
    await client.query('BEGIN');
    await employeeNested.ensureEmployeeProfileSchema(client);

    const designationResolved = await employeeNested.resolveDesignationName(client, companyId, body.designation_id);
    if (!designationResolved.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, designationResolved.message);
    }
    const designationName = designationResolved.name || (body.designation ? String(body.designation).trim() : null);

    const departmentResolved = await employeeNested.resolveDepartmentName(client, companyId, body.department_id);
    if (!departmentResolved.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, departmentResolved.message);
    }
    const departmentName = departmentResolved.name || (body.department ? String(body.department).trim() : null);

    const employeeTypeResolved = await employeeNested.resolveEmployeeTypeId(client, companyId, body.employee_type_id);
    if (!employeeTypeResolved.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, employeeTypeResolved.message);
    }

    let workLocationId = null;
    if (body.work_location_id !== undefined && body.work_location_id !== null && String(body.work_location_id).trim() !== '') {
      workLocationId = Number(body.work_location_id);
      if (!Number.isInteger(workLocationId) || workLocationId <= 0) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'work_location_id must be a positive integer.');
      }
      const locationCheck = await client.query(
        `SELECT id FROM attendance_location_settings WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [workLocationId, companyId]
      );
      if (locationCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Work location not found for this company.');
      }
    }

    let shiftId = null;
    if (body.shift_id !== undefined && body.shift_id !== null && String(body.shift_id).trim() !== '') {
      shiftId = Number(body.shift_id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'shift_id must be a positive integer.');
      }
      const shiftCheck = await client.query(`SELECT id FROM shifts WHERE id = $1 AND company_id = $2`, [shiftId, companyId]);
      if (shiftCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return sendError(res, 404, 'Shift not found for this company.');
      }
    }

    // Permission role — staged on employee_job_details now (no users row exists until
    // activation); activateOnboardingEmployee copies it onto users.access_role_id then.
    accessRoleResolved = await employeeNested.resolveAccessRoleId(client, companyId, body.access_role_id);
    if (!accessRoleResolved.ok) {
      await client.query('ROLLBACK');
      return sendError(res, 400, accessRoleResolved.message);
    }

    const existingUser = await client.query(`SELECT id FROM users WHERE email = ANY($1::text[])`, [
      [...new Set([personalEmail, workEmail])],
    ]);
    if (existingUser.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An account with this email already exists.');
    }
    const existingInvite = await client.query(
      `SELECT id FROM employees
       WHERE company_id = $1 AND LOWER(personal_email) = LOWER($2)
         AND onboarding_status IN ('pending_invite', 'pre_boarding')`,
      [companyId, personalEmail]
    );
    if (existingInvite.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An onboarding invite is already pending for this email.');
    }
    const existingCode = await client.query(`SELECT id FROM employees WHERE LOWER(employee_code) = LOWER($1)`, [
      employeeCode,
    ]);
    if (existingCode.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An employee with this employee code already exists.');
    }

    const createdAtUtc = utcNowForPgTimestamp();
    const insertedEmployee = await client.query(
      `INSERT INTO employees (
         company_id, first_name, last_name, personal_email, work_email, employee_code, home_phone,
         country, state_province, city, onboarding_status, invited_by, invited_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'N/A', 'N/A', 'N/A', 'pending_invite', $8, $9::timestamp, $9::timestamp)
       RETURNING id, first_name, last_name, personal_email, work_email, employee_code, onboarding_status`,
      [
        companyId,
        firstName,
        lastName,
        personalEmail,
        workEmail,
        employeeCode,
        homePhone,
        req.authUser.userId,
        createdAtUtc,
      ]
    );
    employee = insertedEmployee.rows[0];

    const resolvedDesignationId = parsePositiveInt(body.designation_id);
    const resolvedDepartmentId = parsePositiveInt(body.department_id);

    await client.query(
      `INSERT INTO employee_job_details (
         employee_id, company_id, designation, department, department_id, designation_id,
         employee_type_id, work_location_id, shift_id, hire_date, joining_date, access_role_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $10::date, $11)`,
      [
        employee.id,
        companyId,
        designationName,
        departmentName,
        resolvedDepartmentId,
        resolvedDesignationId,
        employeeTypeResolved.id,
        workLocationId,
        shiftId,
        joiningDate,
        accessRoleResolved.id,
      ]
    );

    if (body.line_manager_id !== undefined && body.line_manager_id !== null && String(body.line_manager_id).trim() !== '') {
      const lineManagerParsed = lineManagerService.parseEmployeeLineManagers({ line_manager_id: body.line_manager_id });
      if (lineManagerParsed.error) {
        await client.query('ROLLBACK');
        return sendError(res, 400, lineManagerParsed.error);
      }
      const lmCheck = await lineManagerService.validateEmployeeLineManagersAssignment(client, {
        companyId,
        employeeId: employee.id,
        departmentId: resolvedDepartmentId,
        assignments: lineManagerParsed.omitted ? [] : lineManagerParsed.assignments || [],
      });
      if (!lmCheck.ok) {
        await client.query('ROLLBACK');
        return sendError(res, lmCheck.status || 400, lmCheck.message);
      }
      // replaceEmployeeLineManagers also syncs employee_job_details.line_manager_id (primary manager).
      await lineManagerService.replaceEmployeeLineManagers(client, {
        companyId,
        employeeId: employee.id,
        assignments: lmCheck.assignments,
      });
    }

    await grantActivePolicyBalancesForEmployee(
      client,
      companyId,
      employee.id,
      createdAtUtc,
      resolvedDepartmentId,
      resolvedDesignationId,
      joiningDate || createdAtUtc
    );

    const inviteToken = signOnboardingToken(employee.id, companyId);
    onboardingUrl = buildOnboardingInviteUrl(inviteToken);

    await client.query(`UPDATE employees SET invited_at = $1::timestamp WHERE id = $2`, [createdAtUtc, employee.id]);

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error.code === '23505') {
      return sendError(res, 409, 'An employee with this email or employee code already exists.');
    }
    console.error('inviteEmployee error:', error);
    return sendError(res, 500, 'Something went wrong while sending the onboarding invite.');
  } finally {
    client.release();
  }

  const emailResult = await sendOnboardingInviteEmailSafe({
    toEmail: personalEmail,
    companyId,
    employeeName: `${firstName} ${lastName}`.trim(),
    onboardingUrl,
  });

  return sendSuccess(res, 201, 'Onboarding invite sent successfully.', {
    employee_id: serializeRowId(employee.id),
    first_name: employee.first_name,
    last_name: employee.last_name,
    email: employee.work_email || employee.personal_email,
    personal_email: employee.personal_email,
    work_email: employee.work_email,
    employee_code: employee.employee_code,
    onboarding_status: employee.onboarding_status,
    access_role_id: serializeRowId(accessRoleResolved.id),
    access_role_name: accessRoleResolved.name ?? null,
    invite_url: onboardingUrl,
    invite_email_sent: Boolean(emailResult.sent),
  });
}

/** POST /api/v1/employee-onboarding/:employeeId/resend */
async function resendOnboardingInvite(req, res) {
  const employeeId = parsePositiveInt(req.params.employeeId);
  if (!employeeId) return sendError(res, 400, 'employeeId must be a positive integer.');
  const companyId = req.authUser.companyId;

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, personal_email, onboarding_status FROM employees WHERE id = $1 AND company_id = $2`,
      [employeeId, companyId]
    );
    if (result.rowCount === 0) return sendError(res, 404, 'Employee not found.');
    const employee = result.rows[0];
    if (employee.onboarding_status === ONBOARDING_STATUSES.ACTIVE) {
      return sendError(res, 400, 'This employee has already been activated.');
    }
    if (!employee.personal_email) {
      return sendError(res, 400, 'This employee has no personal_email on file to send the invite to.');
    }

    const inviteToken = signOnboardingToken(employee.id, companyId);
    const onboardingUrl = buildOnboardingInviteUrl(inviteToken);
    await pool.query(`UPDATE employees SET invited_at = NOW() WHERE id = $1`, [employee.id]);

    const emailResult = await sendOnboardingInviteEmailSafe({
      toEmail: employee.personal_email,
      companyId,
      employeeName: `${employee.first_name} ${employee.last_name}`.trim(),
      onboardingUrl,
    });

    return sendSuccess(res, 200, 'Onboarding invite resent successfully.', {
      employee_id: serializeRowId(employee.id),
      invite_url: onboardingUrl,
      invite_email_sent: Boolean(emailResult.sent),
    });
  } catch (error) {
    console.error('resendOnboardingInvite error:', error);
    return sendError(res, 500, 'Something went wrong while resending the onboarding invite.');
  }
}

/**
 * POST /api/v1/employee-onboarding/me/request-resend
 *
 * Employee-initiated — called once their invite link has expired (requireOnboardingToken
 * already rejected it with `code: 'token_expired'` at that point). Deliberately does NOT use
 * requireOnboardingToken, since by definition the token here is expired; it verifies the same
 * token's signature/purpose with `ignoreExpiration: true` just to identify who's asking.
 *
 * This never issues a new token/link directly — resending stays an explicit Company Admin
 * action (POST /employee-onboarding/:employeeId/resend). It only checks whether the previous
 * invite is actually expired (rejects with a "you already have a valid invite" error if not,
 * so this can't be used to skip the wait or spam a fresh link), and if it is, emails whoever
 * invited the employee (employees.invited_by) so they can resend it.
 */
async function requestOnboardingInviteResend(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : String(req.body?.token || req.query?.token || '').trim();
  if (!token) {
    return sendError(res, 401, 'Onboarding token is required.', { code: 'token_required' });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return sendError(res, 500, 'Server configuration error. Please try again later.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret, { ignoreExpiration: true });
  } catch {
    return sendError(res, 400, 'Your onboarding link is invalid.', { code: 'token_invalid' });
  }
  if (decoded.purpose !== ONBOARDING_TOKEN_PURPOSE || !decoded.employeeId || !decoded.companyId) {
    return sendError(res, 400, 'Your onboarding link is invalid.', { code: 'token_invalid' });
  }

  try {
    const empResult = await pool.query(
      `SELECT id, company_id, onboarding_status, invited_by, first_name, last_name,
              (invited_at IS NOT NULL AND invited_at > NOW() - ($3 || ' minutes')::interval) AS invite_still_valid
       FROM employees WHERE id = $1 AND company_id = $2`,
      [decoded.employeeId, decoded.companyId, ONBOARDING_INVITE_EXPIRES_MINUTES]
    );
    if (empResult.rowCount === 0) {
      return sendError(res, 404, 'Onboarding record not found.', { code: 'employee_not_found' });
    }
    const employee = empResult.rows[0];
    if (employee.onboarding_status === ONBOARDING_STATUSES.ACTIVE) {
      return sendError(
        res,
        400,
        'Onboarding is already complete for this account. Please log in instead.',
        { code: 'onboarding_already_active' }
      );
    }
    if (employee.invite_still_valid) {
      return sendError(
        res,
        409,
        'You already have a valid, active invite link. Please check your email (including spam) — it has not expired yet.',
        { code: 'invite_still_valid' }
      );
    }

    if (employee.invited_by) {
      try {
        const adminResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [employee.invited_by]);
        const adminEmail = adminResult.rows[0]?.email;
        if (adminEmail) {
          const branding = await fetchCompanyBranding(employee.company_id);
          const emailResult = await sendEmployeeOnboardingResendRequestedEmail(adminEmail, {
            companyId: employee.company_id,
            employeeId: employee.id,
            employeeName: `${employee.first_name} ${employee.last_name}`.trim(),
            ...branding,
          });
          if (!emailResult?.sent) {
            console.error(
              `Onboarding resend-request email not sent for ${adminEmail}: ${emailResult?.reason || 'unknown error'}`
            );
          }
        } else {
          console.error(`Onboarding resend-request email skipped: no email for inviter user ${employee.invited_by}`);
        }
      } catch (mailError) {
        console.error('Onboarding resend-request email error:', mailError);
      }
    } else {
      console.error(`Onboarding resend-request email skipped: employee ${employee.id} has no invited_by on file.`);
    }

    return sendSuccess(
      res,
      200,
      'Your request for a new invite link has been submitted. You will receive an email once your new invite link is ready.',
      {}
    );
  } catch (error) {
    console.error('requestOnboardingInviteResend error:', error);
    return sendError(res, 500, 'Something went wrong while requesting a new invite link.');
  }
}

/** GET /api/v1/employee-onboarding/:employeeId */
async function getOnboardingEmployeeById(req, res) {
  const employeeId = parsePositiveInt(req.params.employeeId);
  if (!employeeId) return sendError(res, 400, 'employeeId must be a positive integer.');
  const companyId = req.authUser.companyId;

  try {
    const payload = await buildOnboardingProfilePayload(pool, employeeId, companyId);
    if (!payload) return sendError(res, 404, 'Employee not found.');
    return sendSuccess(res, 200, 'Onboarding profile fetched successfully.', payload);
  } catch (error) {
    console.error('getOnboardingEmployeeById error:', error);
    return sendError(res, 500, 'Something went wrong while fetching the onboarding profile.');
  }
}

/** PATCH /api/v1/employee-onboarding/:employeeId/documents/:documentId — body: { action: 'approve'|'reject', reason? } */
async function reviewOnboardingDocument(req, res) {
  const employeeId = parsePositiveInt(req.params.employeeId);
  const documentId = parsePositiveInt(req.params.documentId);
  if (!employeeId || !documentId) return sendError(res, 400, 'employeeId and documentId must be positive integers.');

  const action = String(req.body?.action || '').trim().toLowerCase();
  const reason = req.body?.reason !== undefined && req.body?.reason !== null ? String(req.body.reason).trim() : '';
  if (!['approve', 'reject'].includes(action)) {
    return sendError(res, 400, 'action must be "approve" or "reject".');
  }
  if (action === 'reject' && !reason) {
    return sendError(res, 400, 'reason is required when rejecting a document.');
  }

  const companyId = req.authUser.companyId;
  const adminUserId = req.authUser.userId;

  try {
    const docResult = await pool.query(
      `SELECT od.id, e.personal_email, e.first_name, e.last_name, dt.label
       FROM onboarding_documents od
       INNER JOIN employees e ON e.id = od.employee_id
       INNER JOIN document_types dt ON dt.id = od.document_type_id
       WHERE od.id = $1 AND od.employee_id = $2 AND od.company_id = $3`,
      [documentId, employeeId, companyId]
    );
    if (docResult.rowCount === 0) return sendError(res, 404, 'Onboarding document not found.');
    const doc = docResult.rows[0];

    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(
      `UPDATE onboarding_documents
       SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4`,
      [nextStatus, action === 'reject' ? reason : null, adminUserId, documentId]
    );

    if (action === 'reject' && doc.personal_email) {
      let emailResult = { sent: false, reason: 'unknown error' };
      try {
        // The employee can't act on a rejection without a working link — issue a fresh
        // onboarding token (same as an explicit Resend Invite) and reset the 30-minute
        // window, rather than linking to a bare /onboarding with no token, or relying on
        // the original invite token which has almost certainly expired by review time.
        const inviteToken = signOnboardingToken(employeeId, companyId);
        const onboardingUrl = buildOnboardingInviteUrl(inviteToken);
        await pool.query(`UPDATE employees SET invited_at = NOW() WHERE id = $1`, [employeeId]);

        const branding = await fetchCompanyBranding(companyId);
        emailResult = await sendEmployeeOnboardingDocumentRejectedEmail(doc.personal_email, {
          companyId,
          employeeName: `${doc.first_name} ${doc.last_name}`.trim(),
          documentLabel: doc.label,
          reason,
          onboardingUrl,
          ...branding,
        });
      } catch (mailError) {
        emailResult = { sent: false, reason: mailError.message };
      }
      if (!emailResult.sent) {
        console.error(`Email failed for document rejection (${doc.personal_email}): ${emailResult.reason}`);
      }
    }

    return sendSuccess(res, 200, `Document ${nextStatus} successfully.`, {
      onboarding_document_id: serializeRowId(documentId),
      status: nextStatus,
    });
  } catch (error) {
    console.error('reviewOnboardingDocument error:', error);
    return sendError(res, 500, 'Something went wrong while reviewing the document.');
  }
}

/** POST /api/v1/employee-onboarding/:employeeId/activate */
async function activateOnboardingEmployee(req, res) {
  const employeeId = parsePositiveInt(req.params.employeeId);
  if (!employeeId) return sendError(res, 400, 'employeeId must be a positive integer.');
  const companyId = req.authUser.companyId;
  const workEmailInput = req.body?.work_email ? String(req.body.work_email).trim().toLowerCase() : '';
  if (workEmailInput && !EMAIL_REGEX.test(workEmailInput)) {
    return sendError(res, 400, 'Please provide a valid work_email.');
  }

  const client = await pool.connect();
  let loginEmail;
  let temporaryPassword;
  try {
    await client.query('BEGIN');

    const empResult = await client.query(
      `SELECT id, first_name, last_name, personal_email, work_email, onboarding_status
       FROM employees WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [employeeId, companyId]
    );
    if (empResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Employee not found.');
    }
    const employee = empResult.rows[0];
    if (employee.onboarding_status === ONBOARDING_STATUSES.ACTIVE) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'This employee has already been activated.');
    }
    if (employee.onboarding_status !== ONBOARDING_STATUSES.PRE_BOARDING) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Employee must submit their onboarding application before activation.');
    }

    const pendingRejections = await client.query(
      `SELECT id FROM onboarding_documents WHERE employee_id = $1 AND status = 'rejected'`,
      [employeeId]
    );
    if (pendingRejections.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Resolve rejected documents before activating this employee.');
    }

    loginEmail = workEmailInput || employee.work_email || employee.personal_email;
    if (!loginEmail) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Employee has no email on file to use as their login.');
    }
    const existingUser = await client.query(`SELECT id FROM users WHERE email = $1`, [loginEmail]);
    if (existingUser.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'An account with this login email already exists.');
    }

    temporaryPassword = generateOnboardingTemporaryPassword();
    const temporaryPasswordHash = await bcrypt.hash(temporaryPassword, 10);
    const nowUtc = utcNowForPgTimestamp();

    // Carries over the permission role Company Admin picked at invite time
    // (staged on employee_job_details) onto the login account being created now.
    const stagedAccessRole = await client.query(
      `SELECT access_role_id FROM employee_job_details WHERE employee_id = $1 AND company_id = $2`,
      [employee.id, companyId]
    );
    const accessRoleId = stagedAccessRole.rows[0]?.access_role_id ?? null;

    await client.query(
      `INSERT INTO users (
         company_id, employee_id, full_name, email, password_hash, role, access_role_id, is_active, is_email_verified,
         mfa_enabled, signup_type, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, false, 'email', $8::timestamp, $8::timestamp)`,
      [
        companyId,
        employee.id,
        `${employee.first_name} ${employee.last_name}`.trim(),
        loginEmail,
        temporaryPasswordHash,
        USER_ROLES.EMPLOYEE,
        accessRoleId,
        nowUtc,
      ]
    );

    await client.query(
      `UPDATE employees
       SET onboarding_status = 'active', onboarding_activated_at = NOW(), work_email = COALESCE($1, work_email),
           lms_required = TRUE
       WHERE id = $2`,
      [workEmailInput || null, employee.id]
    );

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error.code === '23505') {
      return sendError(res, 409, 'An account with this login email already exists.');
    }
    console.error('activateOnboardingEmployee error:', error);
    return sendError(res, 500, 'Something went wrong while activating the employee.');
  } finally {
    client.release();
  }

  let emailResult = { sent: false, reason: 'unknown error' };
  try {
    emailResult = await sendEmployeeTemporaryCredentialsEmail(loginEmail, temporaryPassword, { companyId });
  } catch (mailError) {
    emailResult = { sent: false, reason: mailError.message };
  }
  if (!emailResult.sent) {
    console.error(`Email failed for onboarding activation credentials (${loginEmail}): ${emailResult.reason}`);
  }

  return sendSuccess(res, 200, 'Employee activated successfully. Login credentials sent.', {
    employee_id: serializeRowId(employeeId),
    login_email: loginEmail,
    credentials_email_sent: Boolean(emailResult.sent),
  });
}

// ---------------------------------------------------------------------------
// Employee (self-service, token-authenticated) endpoints
// ---------------------------------------------------------------------------

/** GET /api/v1/employee-onboarding/me */
async function getMyOnboardingProfile(req, res) {
  const { id: employeeId, companyId } = req.onboardingEmployee;
  try {
    const payload = await buildOnboardingProfilePayload(pool, employeeId, companyId);
    if (!payload) return sendError(res, 404, 'Onboarding record not found.');
    return sendSuccess(res, 200, 'Onboarding profile fetched successfully.', payload);
  } catch (error) {
    console.error('getMyOnboardingProfile error:', error);
    return sendError(res, 500, 'Something went wrong while fetching your onboarding profile.');
  }
}

/**
 * GET /api/v1/employee-onboarding/me/religions — read-only, company-scoped religion list for
 * the onboarding form's Religion dropdown. The admin-side GET /v1/religions is gated by
 * protect('religions','view') → requireAuth, which needs a real login JWT carrying
 * userId + email; the onboarding token (only {employeeId, companyId, purpose}) doesn't
 * satisfy that and 401s there, so this mirrors it under requireOnboardingToken instead.
 */
async function listMyOnboardingReligions(req, res) {
  const { companyId } = req.onboardingEmployee;
  try {
    const result = await pool.query(
      `SELECT id, value, label FROM religions WHERE company_id = $1 ORDER BY label ASC`,
      [companyId]
    );
    return sendSuccess(res, 200, 'Religions fetched successfully.', {
      religions: result.rows.map((row) => ({ id: Number(row.id), value: row.value, label: row.label })),
    });
  } catch (error) {
    console.error('listMyOnboardingReligions error:', error);
    return sendError(res, 500, 'Something went wrong while fetching religions.');
  }
}

/**
 * GET /api/v1/employee-onboarding/me/relationship-options — same reasoning as
 * /me/religions: GET /v1/dependants/relationship-options is gated by protect('dependants',
 * 'view') → requireAuth, which the onboarding token can't satisfy. Reuses the exact same
 * merge-defaults-with-company-custom-types logic dependants.controller.js already has.
 */
async function listMyOnboardingRelationshipOptions(req, res) {
  const { companyId } = req.onboardingEmployee;
  try {
    const relationships = await dependantsController.buildRelationshipOptionsList(companyId);
    return sendSuccess(res, 200, 'Relationship options fetched successfully.', { relationships });
  } catch (error) {
    console.error('listMyOnboardingRelationshipOptions error:', error);
    return sendError(res, 500, 'Something went wrong while fetching relationship options.');
  }
}

/**
 * POST /api/v1/employee-onboarding/me/relationship-types — onboarding-token mirror of
 * POST /v1/dependant-relationship-types (also gated by requireAuth). Delegates to the real
 * controller so validation/insert/conflict handling stay in one place, but forces company_id
 * from the verified token instead of trusting the request body — an onboarding employee
 * should only ever be able to create a relationship type for their own company.
 */
async function createMyOnboardingRelationshipType(req, res) {
  const { companyId } = req.onboardingEmployee;
  req.body = { ...req.body, company_id: companyId };
  return dependantRelationshipTypesController.createDependantRelationshipType(req, res);
}

/**
 * PATCH /api/v1/employee-onboarding/me — body: {
 *   personal: {...}, employee_bank: {...},
 *   documents: [{ document_type_id, file_url, file_name }, { document_type_id, skip, skip_reason }, ...],
 *   dependants: [{ full_name, phone_no, relationship }, id, ...]
 * }
 *
 * Accepts the same field names/aliases as Add Employee / Update Employee (personal.cnic,
 * personal.phone_no, personal.current_address, employee_bank, etc.) via the shared
 * flattenNestedPatchForUpdate helper, restricted to what an employee may edit about
 * themselves — no employee_code, designation/department, or salary changes here.
 * personal/employee_bank/documents/dependants are all independently optional — only the
 * sections present in the body are touched. documents are upserted one by one against
 * onboarding_documents (keyed by document_type_id, multiple entries). dependants fully
 * replaces the dependant list each call — pass an existing id to keep one, or an object
 * with full_name/phone_no/relationship to create a new one inline (POST /dependants
 * needs a real login token, which the onboarding link doesn't have, so this is the only
 * way self-service onboarding can actually add a dependant); multiple entries supported.
 */
async function updateMyOnboardingProfile(req, res) {
  const { id: employeeId, companyId } = req.onboardingEmployee;
  const body = req.body || {};
  const { patch: flattenedPatch } = employeeNested.flattenNestedPatchForUpdate({ personal: body.personal });

  const updates = [];
  const values = [];
  let idx = 1;
  const setColumn = (column, value) => {
    updates.push(`${column} = $${idx++}`);
    values.push(value);
  };
  const has = (key) => Object.prototype.hasOwnProperty.call(flattenedPatch, key);

  if (has('first_name')) {
    const v = String(flattenedPatch.first_name || '').trim();
    if (!v || v.length < 2) return sendError(res, 400, 'first_name must be at least 2 characters.');
    setColumn('first_name', v);
  }
  if (has('last_name')) {
    const v = String(flattenedPatch.last_name || '').trim();
    if (!v || v.length < 2) return sendError(res, 400, 'last_name must be at least 2 characters.');
    setColumn('last_name', v);
  }
  if (has('profile_picture_url')) {
    setColumn('profile_picture_url', flattenedPatch.profile_picture_url ? String(flattenedPatch.profile_picture_url).trim() || null : null);
  }
  if (has('gender')) {
    const v = flattenedPatch.gender ? String(flattenedPatch.gender).trim().toLowerCase() : null;
    if (v && !PROFILE_GENDERS.has(v)) return sendError(res, 400, 'gender must be male, female, or other.');
    setColumn('gender', v);
  }
  if (has('dob')) {
    const dobResult = parseOptionalDateInput(flattenedPatch.dob, 'dob');
    if (dobResult.error) return sendError(res, 400, dobResult.error);
    updates.push(`dob = $${idx++}::date`);
    values.push(dobResult.value);
  }
  if (has('marital_status')) {
    const v = flattenedPatch.marital_status ? String(flattenedPatch.marital_status).trim() : null;
    if (v && !MARITAL_STATUSES.has(v)) {
      return sendError(res, 400, 'marital_status must be one of: Single, Married, Divorced, Widowed, Separated.');
    }
    setColumn('marital_status', v);
  }
  if (has('national_id_expiry')) {
    const r = parseOptionalDateInput(flattenedPatch.national_id_expiry, 'national_id_expiry');
    if (r.error) return sendError(res, 400, r.error);
    updates.push(`national_id_expiry = $${idx++}::date`);
    values.push(r.value);
  }
  if (has('home_phone')) {
    const raw = flattenedPatch.home_phone;
    if (raw === null || String(raw).trim() === '') {
      setColumn('home_phone', null);
    } else {
      const phoneResult = requireE164(raw, { fieldName: 'phone number' });
      if (phoneResult.error) return sendError(res, 400, phoneResult.error);
      setColumn('home_phone', phoneResult.e164);
    }
  }
  if (has('temporary_address')) {
    setColumn('temporary_address', flattenedPatch.temporary_address ? String(flattenedPatch.temporary_address).trim().slice(0, 2000) || null : null);
  }
  if (has('permanent_address')) {
    setColumn('permanent_address', flattenedPatch.permanent_address ? String(flattenedPatch.permanent_address).trim().slice(0, 2000) || null : null);
  }
  if (has('country')) {
    setColumn('country', flattenedPatch.country ? String(flattenedPatch.country).trim().slice(0, 80) || null : null);
  }
  if (has('religion')) {
    setColumn('religion', flattenedPatch.religion ? String(flattenedPatch.religion).trim().slice(0, 60) || null : null);
  }
  if (has('national_id')) {
    setColumn('national_id', flattenedPatch.national_id ? String(flattenedPatch.national_id).trim().slice(0, 50) || null : null);
  }
  // employee_code is deliberately not applied even though flattenNestedPatchForUpdate supports
  // it — that stays HR-assigned, same as designation/department/salary.

  // Fields the shared helper doesn't cover (state/city breakdown, tax id, emergency contact) —
  // read straight off `personal`, same attribute names the rest of the app already uses for them.
  const personal = body.personal && typeof body.personal === 'object' ? body.personal : {};
  const pushString = (key, column, maxLength) => {
    if (personal[key] === undefined) return;
    const v = personal[key] === null ? null : String(personal[key]).trim().slice(0, maxLength) || null;
    setColumn(column, v);
  };
  pushString('ntn_no', 'ntn_no', 50);
  pushString('state_province', 'state_province', 80);
  pushString('city', 'city', 80);
  pushString('emergency_contact_name', 'emergency_contact_name', 120);
  if (personal.emergency_contact_no !== undefined) {
    if (personal.emergency_contact_no === null || String(personal.emergency_contact_no).trim() === '') {
      setColumn('emergency_contact_no', null);
    } else {
      const phoneResult = requireE164(personal.emergency_contact_no, { fieldName: 'emergency contact number' });
      if (phoneResult.error) return sendError(res, 400, phoneResult.error);
      setColumn('emergency_contact_no', phoneResult.e164);
    }
  }

  // Same key names/aliases addEmployee/updateEmployeeById accept for the bank object.
  const bankInput = body.employee_bank ?? body.employeeBank ?? body.bank_details ?? body.employee_bank_details ?? body.bank;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await employeeNested.ensureEmployeeProfileSchema(client);

    if (updates.length > 0) {
      values.push(employeeId, companyId);
      const idPos = idx++;
      const companyPos = idx++;
      await client.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = $${idPos} AND company_id = $${companyPos}`,
        values
      );
    }

    if (bankInput !== undefined) {
      const bankPayload = employeeNested.parseEmployeeBankPayload(bankInput);
      if (!bankPayload.ok) {
        await client.query('ROLLBACK');
        return sendError(res, 400, bankPayload.message);
      }
      if (bankPayload.value) {
        await employeeNested.upsertEmployeeBankDetails(client, employeeId, companyId, bankPayload.value);
      }
    }

    // documents: [{ document_type_id, file_url, file_name }] or [{ document_type_id, skip, skip_reason }] — multiple, upserted one by one
    if (Array.isArray(body.documents)) {
      for (const doc of body.documents) {
        if (!doc || typeof doc !== 'object') continue;
        const docResult = await upsertOnboardingDocumentRow(client, employeeId, companyId, doc);
        if (docResult.error) {
          await client.query('ROLLBACK');
          return sendError(res, 400, docResult.error);
        }
      }
    }

    // dependants: [id, ...] to keep/attach an existing dependant, or [{ full_name, phone_no,
    // relationship }, ...] to create a brand-new one inline — mixed array, multiple entries.
    // Replaces the full dependant list each call, same semantics as POST /me/dependants.
    const dependantsInput = body.dependants ?? body.dependant_ids;
    if (dependantsInput !== undefined) {
      if (!Array.isArray(dependantsInput)) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'dependants must be an array.');
      }

      const resolvedIds = [];
      for (const dep of dependantsInput) {
        if (dep && typeof dep === 'object' && !Array.isArray(dep)) {
          const existingId = parsePositiveInt(dep.id ?? dep.dependant_id);
          if (existingId) {
            resolvedIds.push(existingId);
            continue;
          }
          const created = await dependantsController.createDependantRecord(client, companyId, dep);
          if (!created.ok) {
            await client.query('ROLLBACK');
            return sendError(res, 400, created.message);
          }
          resolvedIds.push(Number(created.dependant.id));
          continue;
        }
        const plainId = parsePositiveInt(dep);
        if (plainId) resolvedIds.push(plainId);
      }

      try {
        await employeeNested.saveEmployeeDependantIds(client, employeeId, companyId, resolvedIds);
      } catch (depErr) {
        await client.query('ROLLBACK');
        if (depErr.message && depErr.message.startsWith('DEPENDANT_NOT_FOUND:')) {
          const badId = depErr.message.split(':')[1];
          return sendError(res, 400, `Invalid dependant id: ${badId} for this company.`);
        }
        throw depErr;
      }
    }

    await client.query('COMMIT');

    const payload = await buildOnboardingProfilePayload(pool, employeeId, companyId);
    return sendSuccess(res, 200, 'Onboarding profile updated successfully.', payload);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('updateMyOnboardingProfile error:', error);
    return sendError(res, 500, 'Something went wrong while updating your onboarding profile.');
  } finally {
    client.release();
  }
}

/** POST /api/v1/employee-onboarding/me/documents — body: { document_type_id, file_url, file_name } or { document_type_id, skip: true, skip_reason } */
async function upsertMyOnboardingDocument(req, res) {
  const { id: employeeId, companyId } = req.onboardingEmployee;
  const body = req.body || {};

  try {
    const result = await upsertOnboardingDocumentRow(pool, employeeId, companyId, body);
    if (result.error) return sendError(res, 400, result.error);

    return sendSuccess(res, 200, 'Document saved successfully.', {
      onboarding_document_id: result.onboarding_document_id,
      status: result.status,
    });
  } catch (error) {
    console.error('upsertMyOnboardingDocument error:', error);
    return sendError(res, 500, 'Something went wrong while saving the document.');
  }
}

/** POST /api/v1/employee-onboarding/me/dependants — body: { dependant_ids: [...] } */
async function setMyOnboardingDependants(req, res) {
  const { id: employeeId, companyId } = req.onboardingEmployee;
  const dependantIds = employeeNested.parseDependantIdsArray(req.body?.dependant_ids);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await employeeNested.saveEmployeeDependantIds(client, employeeId, companyId, dependantIds);
    await client.query('COMMIT');

    const dependants = await employeeNested.fetchDependantsForEmployee(pool, employeeId, companyId);
    return sendSuccess(res, 200, 'Dependants updated successfully.', { dependants });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (error.message && error.message.startsWith('DEPENDANT_NOT_FOUND:')) {
      const badId = error.message.split(':')[1];
      return sendError(res, 400, `Invalid dependant id: ${badId} for this company.`);
    }
    console.error('setMyOnboardingDependants error:', error);
    return sendError(res, 500, 'Something went wrong while updating dependants.');
  } finally {
    client.release();
  }
}

/** POST /api/v1/employee-onboarding/me/submit */
async function submitMyOnboardingProfile(req, res) {
  const { id: employeeId, companyId } = req.onboardingEmployee;

  const client = await pool.connect();
  let employee;
  try {
    await client.query('BEGIN');

    const empResult = await client.query(
      `SELECT id, onboarding_status, invited_by, first_name, last_name
       FROM employees WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [employeeId, companyId]
    );
    if (empResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Onboarding record not found.');
    }
    employee = empResult.rows[0];
    if (employee.onboarding_status === ONBOARDING_STATUSES.ACTIVE) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Onboarding is already complete.');
    }

    const mandatoryGaps = await client.query(
      `SELECT dt.id, dt.label
       FROM document_types dt
       LEFT JOIN onboarding_documents od ON od.document_type_id = dt.id AND od.employee_id = $1
       WHERE dt.company_id = $2
         AND dt.is_mandatory = true
         AND (od.id IS NULL OR od.status = 'rejected')`,
      [employeeId, companyId]
    );
    if (mandatoryGaps.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Please upload or skip (with a reason) all mandatory documents before submitting.', {
        missing_documents: mandatoryGaps.rows.map((r) => ({ document_type_id: serializeRowId(r.id), label: r.label })),
      });
    }

    await client.query(
      `UPDATE employees SET onboarding_status = 'pre_boarding', onboarding_submitted_at = NOW() WHERE id = $1`,
      [employeeId]
    );

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('submitMyOnboardingProfile error:', error);
    return sendError(res, 500, 'Something went wrong while submitting your onboarding application.');
  } finally {
    client.release();
  }

  if (employee.invited_by) {
    let emailResult = { sent: false, reason: 'unknown error' };
    try {
      const adminResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [employee.invited_by]);
      const adminEmail = adminResult.rows[0]?.email;
      if (adminEmail) {
        const branding = await fetchCompanyBranding(companyId);
        emailResult = await sendEmployeeOnboardingSubmittedEmail(adminEmail, {
          companyId,
          employeeName: `${employee.first_name} ${employee.last_name}`.trim(),
          ...branding,
        });
      }
    } catch (mailError) {
      emailResult = { sent: false, reason: mailError.message };
    }
    if (!emailResult.sent) {
      console.error(`Email failed for onboarding submitted notice: ${emailResult.reason}`);
    }
  }

  return sendSuccess(
    res,
    200,
    'Your application has been submitted. Your account will be activated after HR reviews it.',
    { onboarding_status: 'pre_boarding' }
  );
}

module.exports = {
  inviteEmployee,
  resendOnboardingInvite,
  requestOnboardingInviteResend,
  getOnboardingEmployeeById,
  reviewOnboardingDocument,
  activateOnboardingEmployee,
  getMyOnboardingProfile,
  listMyOnboardingReligions,
  listMyOnboardingRelationshipOptions,
  createMyOnboardingRelationshipType,
  updateMyOnboardingProfile,
  upsertMyOnboardingDocument,
  setMyOnboardingDependants,
  submitMyOnboardingProfile,
};
