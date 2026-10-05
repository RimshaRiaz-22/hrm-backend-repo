const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendError } = require('../utils/apiResponse');
const { ONBOARDING_TOKEN_PURPOSE } = require('../constants/onboarding');

/**
 * Authenticates the new hire's pre-boarding portal via the emailed invite token —
 * no password/login exists yet at this stage, so this replaces requireAuth for
 * the employee-facing onboarding endpoints only.
 */
async function requireOnboardingToken(req, res, next) {
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
    decoded = jwt.verify(token, jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 400, 'Your onboarding link has expired. Please ask HR to resend the invite.', {
        code: 'token_expired',
      });
    }
    return sendError(res, 400, 'Your onboarding link is invalid.', { code: 'token_invalid' });
  }

  if (decoded.purpose !== ONBOARDING_TOKEN_PURPOSE || !decoded.employeeId || !decoded.companyId) {
    return sendError(res, 400, 'Your onboarding link is invalid.', { code: 'token_invalid' });
  }

  try {
    const result = await pool.query(
      `SELECT id, company_id, onboarding_status FROM employees WHERE id = $1 AND company_id = $2`,
      [decoded.employeeId, decoded.companyId]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, 'Onboarding record not found.', { code: 'employee_not_found' });
    }

    const employee = result.rows[0];
    if (employee.onboarding_status === 'active') {
      return sendError(
        res,
        400,
        'Onboarding is already complete for this account. Please log in instead.',
        { code: 'onboarding_already_active' }
      );
    }

    req.onboardingEmployee = { id: employee.id, companyId: employee.company_id };
    next();
  } catch (error) {
    console.error('requireOnboardingToken error:', error);
    return sendError(res, 500, 'Something went wrong while verifying your onboarding link.');
  }
}

module.exports = { requireOnboardingToken };
