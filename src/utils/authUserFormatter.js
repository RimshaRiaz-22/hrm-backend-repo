/**
 * Builds the canonical `user` object for auth-related API responses.
 */
function splitFullName(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) {
    return { first_name: '', last_name: '' };
  }
  const idx = trimmed.indexOf(' ');
  if (idx === -1) {
    return { first_name: trimmed, last_name: '' };
  }
  return {
    first_name: trimmed.slice(0, idx).trim(),
    last_name: trimmed.slice(idx + 1).trim(),
  };
}

function formatAuthUser(row) {
  const { first_name, last_name } = splitFullName(row.full_name);
  const otpExpires = row.otp_expires_at ? new Date(row.otp_expires_at).toISOString() : null;
  let dobOut = null;
  if (row.dob) {
    const d = row.dob instanceof Date ? row.dob : new Date(row.dob);
    if (!Number.isNaN(d.getTime())) {
      dobOut = d.toISOString().slice(0, 10);
    }
  }

  return {
    id: Number(row.id),
    company_id: row.company_id ?? null,
    profile_image: row.profile_picture_url ?? null,
    name: row.full_name,
    first_name,
    last_name,
    email: row.email,
    role: row.role,
    signup_type: row.signup_type || 'email',
    phone_number: row.phone_number ?? null,
    dob: dobOut,
    mfa_enabled: row.mfa_enabled === true,
    verification_code_expires: row.is_email_verified ? null : otpExpires,
  };
}

/** Login success copy by role (English only). */
function loginSuccessMessageEn(role) {
  const r = String(role || '').toLowerCase();
  const map = {
    super_admin: 'Super Admin login successful',
    company_admin: 'Company Admin login successful',
    department_manager: 'Department Manager login successful',
    employee: 'Employee login successful',
    admin: 'Admin login successful',
    hr: 'HR login successful',
    manager: 'Manager login successful',
  };
  return map[r] || 'Login successful';
}

module.exports = {
  formatAuthUser,
  splitFullName,
  loginSuccessMessageEn,
};
