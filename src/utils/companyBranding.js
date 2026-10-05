const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');

const HR_CONTACT_ROLES = [
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
];


async function fetchCompanyBranding(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) {
    return { companyName: null, companyLogoUrl: null, companyEmail: null };
  }

  const result = await pool.query(
    `SELECT name, logo_url, company_email FROM companies WHERE id = $1`,
    [id]
  );
  const company = result.rows[0] || {};
  let companyEmail = company.company_email
    ? String(company.company_email).trim().toLowerCase()
    : null;

  // Status / HR emails: prefer company email, else first company admin / admin / HR user
  if (!companyEmail) {
    companyEmail = await fetchCompanyHrContactEmail(id);
  }

  return {
    companyName: company.name ?? null,
    companyLogoUrl: company.logo_url ?? null,
    companyEmail,
  };
}


async function fetchCompanyHrContactEmail(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const result = await pool.query(
    `SELECT LOWER(TRIM(u.email)) AS email
     FROM users u
     WHERE u.company_id = $1
       AND u.is_active = true
       AND u.email IS NOT NULL
       AND TRIM(u.email) <> ''
       AND u.role = ANY($2::text[])
     ORDER BY CASE u.role
       WHEN $3 THEN 1
       WHEN $4 THEN 2
       WHEN $5 THEN 3
       ELSE 4
     END,
     u.id ASC
     LIMIT 1`,
    [
      id,
      HR_CONTACT_ROLES,
      USER_ROLES.COMPANY_ADMIN,
      USER_ROLES.ADMIN,
      USER_ROLES.HR,
    ]
  );

  return result.rows[0]?.email || null;
}


async function fetchUserEmailById(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const result = await pool.query(
    `SELECT LOWER(TRIM(email)) AS email
     FROM users
     WHERE id = $1
       AND is_active = true
       AND email IS NOT NULL
       AND TRIM(email) <> ''
     LIMIT 1`,
    [id]
  );
  return result.rows[0]?.email || null;
}

module.exports = {
  fetchCompanyBranding,
  fetchCompanyHrContactEmail,
  fetchUserEmailById,
};
