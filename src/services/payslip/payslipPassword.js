function derivePayslipPassword({ employee_code, national_id, email } = {}) {
  const code = String(employee_code || '').trim();
  if (code) return code;

  const nationalId = String(national_id || '').trim();
  if (nationalId) return nationalId;

  const localPart = String(email || '').split('@')[0].trim();
  if (localPart) return localPart;

  return null;
}

function buildPayslipPasswordHint(password, payslipData = {}) {
  if (!password) return null;

  const code = String(payslipData.employee?.employee_code || '').trim();
  if (code && password === code) {
    return `Use your employee code (${code}) to open the attached PDF.`;
  }

  return 'Use the password provided by your HR department to open the attached PDF.';
}

module.exports = {
  derivePayslipPassword,
  buildPayslipPasswordHint,
};
