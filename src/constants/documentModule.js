const DOCUMENT_REQUEST_TYPES = new Set([
  'experience_letter',
  'salary_certificate',
  'noc',
  'bank_letter',
  'other',
]);

const DOCUMENT_TYPE_LABELS = {
  experience_letter: 'Experience Letter',
  salary_certificate: 'Salary Certificate',
  noc: 'NOC',
  bank_letter: 'Bank Letter',
  other: 'Other',
};

const DOCUMENT_REQUEST_STATUSES = new Set(['pending', 'manager_approved', 'ready', 'rejected', 'cancelled']);

const DOCUMENT_SOURCES = new Set(['employee_upload', 'company_upload']);

const DOCUMENT_TARGET_TYPES = new Set(['self', 'specific', 'multiple', 'all']);

const DOCUMENT_STATUSES = new Set(['pending', 'approved', 'rejected', 'active']);

const ALLOWED_FILE_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

module.exports = {
  DOCUMENT_REQUEST_TYPES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_REQUEST_STATUSES,
  DOCUMENT_SOURCES,
  DOCUMENT_TARGET_TYPES,
  DOCUMENT_STATUSES,
  ALLOWED_FILE_EXTENSIONS,
};
