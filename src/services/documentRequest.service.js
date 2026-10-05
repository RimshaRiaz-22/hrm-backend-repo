const pool = require('../db');
const { DOCUMENT_REQUEST_TYPES, DOCUMENT_REQUEST_STATUSES, DOCUMENT_TYPE_LABELS } = require('../constants/documentModule');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { parsePositiveInt } = require('./documentAuth.service');
const { getEmployeeIdFromAuth, getEmployeeCompanyId } = require('../utils/employeeAuth');
const documentEmailNotification = require('./documentEmailNotification.service');

const LM_SETTABLE_STATUSES = new Set(['manager_approved', 'rejected']);
const HR_ACTIONABLE_STATUSES = new Set(['pending', 'manager_approved']);
const EMPLOYEE_CANCELLABLE_STATUSES = new Set(['pending', 'manager_approved']);
const STATUS_FILTER_HINT =
  'status must be one of: pending, manager_approved, ready, approved, rejected, cancelled.';

/** Query filter: `approved` is accepted as an alias for stored status `ready`. */
function resolveStatusFilter(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (!status || status === 'all') return { status: null };
  if (status === 'approved') return { status: 'ready' };
  if (!DOCUMENT_REQUEST_STATUSES.has(status)) {
    return { error: [400, STATUS_FILTER_HINT] };
  }
  return { status };
}

const REQUEST_SELECT = `dr.id, dr.company_id, dr.employee_id, dr.document_type, dr.purpose,
  dr.addressed_to, dr.note, dr.status, dr.file_url, dr.file_name, dr.rejection_reason,
  dr.manager_comment, dr.manager_reviewed_by, dr.manager_reviewed_at, dr.review_stage,
  dr.reviewed_by, dr.reviewed_at, dr.created_at, dr.updated_at,
  e.employee_code, e.first_name AS employee_first_name, e.last_name AS employee_last_name,
  e.work_email AS employee_email,
  mgr_e.first_name AS manager_reviewer_first_name,
  mgr_e.last_name AS manager_reviewer_last_name,
  mgr_e.work_email AS manager_reviewer_email,
  mgr_e.employee_code AS manager_reviewer_code,
  reviewer.full_name AS hr_reviewer_name,
  reviewer.email AS hr_reviewer_email,
  reviewer.email AS reviewed_by_email`;

const REQUEST_FROM = `FROM document_requests dr
  INNER JOIN employees e ON e.id = dr.employee_id AND e.company_id = dr.company_id
  LEFT JOIN employees mgr_e ON mgr_e.id = dr.manager_reviewed_by AND mgr_e.company_id = dr.company_id
  LEFT JOIN users reviewer ON reviewer.id = dr.reviewed_by`;

const DOCUMENT_TEAM_ACCESS_SQL = `EXISTS (
  SELECT 1 FROM employee_line_managers elm
  WHERE elm.company_id = dr.company_id
    AND elm.employee_id = dr.employee_id
    AND elm.manager_id = $MANAGER_PARAM$
)`;

function mapManagerReviewerSummary(row) {
  if (row.manager_reviewed_by == null) return null;
  return {
    id: Number(row.manager_reviewed_by),
    first_name: row.manager_reviewer_first_name,
    last_name: row.manager_reviewer_last_name,
    email: row.manager_reviewer_email ?? null,
    employee_code: row.manager_reviewer_code ?? null,
    role: 'manager',
  };
}

function mapHrReviewerSummary(row) {
  if (row.reviewed_by == null) return null;
  return {
    id: Number(row.reviewed_by),
    name: row.hr_reviewer_name,
    email: row.hr_reviewer_email ?? null,
    role: 'admin',
  };
}

function resolveApprovedBySummary(status, managerReviewedBy, hrReviewedBy) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'ready' && hrReviewedBy) {
    return {
      type: 'admin',
      id: hrReviewedBy.id,
      name: hrReviewedBy.name,
      email: hrReviewedBy.email,
    };
  }

  if (normalized === 'rejected' && hrReviewedBy) {
    return {
      type: 'admin',
      id: hrReviewedBy.id,
      name: hrReviewedBy.name,
      email: hrReviewedBy.email,
    };
  }

  if (
    (normalized === 'manager_approved' || normalized === 'rejected') &&
    managerReviewedBy
  ) {
    const name = [managerReviewedBy.first_name, managerReviewedBy.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      type: 'manager',
      id: managerReviewedBy.id,
      name: name || null,
      email: managerReviewedBy.email,
      employee_code: managerReviewedBy.employee_code,
    };
  }

  return null;
}

function mapDocumentRequestRow(row) {
  const managerReviewedBy = mapManagerReviewerSummary(row);
  const hrReviewedBy = mapHrReviewerSummary(row);
  const employeeName = [row.employee_first_name, row.employee_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    document_type: row.document_type,
    purpose: row.purpose,
    addressed_to: row.addressed_to,
    note: row.note,
    status: row.status,
    file_url: row.file_url,
    file_name: row.file_name,
    rejection_reason: row.rejection_reason,
    manager_comment: row.manager_comment || null,
    manager_reviewed_by: managerReviewedBy,
    manager_reviewed_at: row.manager_reviewed_at ? toUtcIsoString(row.manager_reviewed_at) : null,
    review_stage: row.review_stage || null,
    reviewed_by: row.reviewed_by ? Number(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    hr_reviewed_by: hrReviewedBy,
    hr_reviewed_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    approved_by: resolveApprovedBySummary(row.status, managerReviewedBy, hrReviewedBy),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
    employee_name: employeeName || null,
    employee_email: row.employee_email || null,
    employee_code: row.employee_code || null,
    employee: {
      id: Number(row.employee_id),
      employee_code: row.employee_code,
      first_name: row.employee_first_name,
      last_name: row.employee_last_name,
      email: row.employee_email,
    },
    reviewed_by_email: row.reviewed_by_email || null,
  };
}

function validateCreatePayload(body) {
  const documentType = String(body.document_type || '').trim().toLowerCase();
  if (!DOCUMENT_REQUEST_TYPES.has(documentType)) {
    return { error: [400, 'document_type must be one of: experience_letter, salary_certificate, noc, bank_letter, other.'] };
  }
  const purpose = String(body.purpose || '').trim();
  if (!purpose) return { error: [400, 'purpose is required.'] };
  if (documentType === 'other' && purpose.length < 10) {
    return { error: [400, 'When document_type is other, purpose must include detailed information.'] };
  }
  return {
    documentType,
    purpose,
    addressedTo: body.addressed_to ? String(body.addressed_to).trim() : null,
    note: body.note ? String(body.note).trim() : null,
  };
}

function appendDocumentSearchFilter(conditions, params, query) {
  const search = String(query.search || '').trim();
  if (!search) return;

  params.push(`%${search}%`);
  const idx = params.length;
  conditions.push(`(
    e.first_name ILIKE $${idx}
    OR e.last_name ILIKE $${idx}
    OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${idx}
    OR COALESCE(e.employee_code, '') ILIKE $${idx}
    OR COALESCE(e.work_email, '') ILIKE $${idx}
    OR dr.document_type ILIKE $${idx}
    OR COALESCE(dr.purpose, '') ILIKE $${idx}
    OR COALESCE(dr.addressed_to, '') ILIKE $${idx}
    OR COALESCE(dr.note, '') ILIKE $${idx}
  )`);
}

async function createDocumentRequest(employeeId, companyId, body) {
  const validated = validateCreatePayload(body);
  if (validated.error) return { error: validated.error };

  const employeeCheck = await pool.query(
    `SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND employment_status != 'exited'`,
    [employeeId, companyId]
  );
  if (employeeCheck.rowCount === 0) return { error: [403, 'Employee profile not found or inactive.'] };

  const result = await pool.query(
    `INSERT INTO document_requests (company_id, employee_id, document_type, purpose, addressed_to, note, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
    [companyId, employeeId, validated.documentType, validated.purpose, validated.addressedTo, validated.note]
  );

  const document_request = await fetchDocumentRequestById(Number(result.rows[0].id), companyId);

  documentEmailNotification
    .notifyDocumentRequestSubmitted(companyId, document_request)
    .catch((error) => {
      console.error('Document request submitted notification error:', error);
    });

  return { document_request };
}

async function fetchDocumentRequestById(requestId, companyId, { employeeId = null } = {}) {
  const values = [requestId, companyId];
  let employeeFilter = '';
  if (employeeId) {
    values.push(employeeId);
    employeeFilter = ` AND dr.employee_id = $${values.length}`;
  }
  const result = await pool.query(
    `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE dr.id = $1 AND dr.company_id = $2${employeeFilter}`,
    values
  );
  if (!result.rows[0]) return null;
  return mapDocumentRequestRow(result.rows[0]);
}

async function listMyDocumentRequests(employeeId, companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, employeeId];
  const conditions = ['dr.company_id = $1', 'dr.employee_id = $2'];
  const statusFilter = resolveStatusFilter(query.status);
  if (statusFilter.error) return { error: statusFilter.error };
  if (statusFilter.status) {
    values.push(statusFilter.status);
    conditions.push(`dr.status = $${values.length}`);
  }

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM document_requests dr WHERE ${whereSql}`,
    values
  );

  let listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE ${whereSql} ORDER BY dr.created_at DESC, dr.id DESC`;
  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    document_requests: listResult.rows.map(mapDocumentRequestRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function listHrDocumentRequests(companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId];
  const conditions = ['dr.company_id = $1'];
  const statusFilter = resolveStatusFilter(query.status);
  if (statusFilter.error) return { error: statusFilter.error };
  if (statusFilter.status) {
    values.push(statusFilter.status);
    conditions.push(`dr.status = $${values.length}`);
  }

  appendDocumentSearchFilter(conditions, values, query);

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${REQUEST_FROM} WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE ${whereSql} ORDER BY dr.created_at DESC, dr.id DESC`;
  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    document_requests: listResult.rows.map(mapDocumentRequestRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

/** GET /v1/document-requests/team — line manager lists direct reports' document requests. */
async function listTeamDocumentRequests(auth, query = {}) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: [404, 'No employee profile linked to this user.'] };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: [404, 'Employee company not found.'] };
  }

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, managerEmployeeId];
  const conditions = [
    'dr.company_id = $1',
    DOCUMENT_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$2'),
  ];

  const statusFilter = resolveStatusFilter(query.status);
  if (statusFilter.error) return { error: statusFilter.error };
  if (statusFilter.status) {
    values.push(statusFilter.status);
    conditions.push(`dr.status = $${values.length}`);
  }

  appendDocumentSearchFilter(conditions, values, query);

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${REQUEST_FROM} WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE ${whereSql} ORDER BY dr.created_at DESC, dr.id DESC`;
  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    document_requests: listResult.rows.map(mapDocumentRequestRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

/** GET /v1/document-requests/team/:id */
async function getTeamDocumentRequestById(auth, requestId) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: [404, 'No employee profile linked to this user.'] };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: [404, 'Employee company not found.'] };
  }

  const id = parsePositiveInt(requestId);
  if (!id) return { error: [400, 'Document request id must be a positive integer.'] };

  const result = await pool.query(
    `SELECT ${REQUEST_SELECT} ${REQUEST_FROM}
     WHERE dr.id = $1
       AND dr.company_id = $2
       AND ${DOCUMENT_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$3')}`,
    [id, companyId, managerEmployeeId]
  );

  if (!result.rows[0]) return { error: [404, 'Document request not found.'] };
  return { document_request: mapDocumentRequestRow(result.rows[0]) };
}

/** PATCH /v1/document-requests/team/:id/status */
async function updateTeamDocumentRequestStatus(auth, requestId, body = {}) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: [404, 'No employee profile linked to this user.'] };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: [404, 'Employee company not found.'] };
  }

  const id = parsePositiveInt(requestId);
  if (!id) return { error: [400, 'Document request id must be a positive integer.'] };

  const newStatus = String(body?.status || '').trim().toLowerCase();
  if (!LM_SETTABLE_STATUSES.has(newStatus)) {
    return {
      error: [400, `status must be one of: ${Array.from(LM_SETTABLE_STATUSES).join(', ')}.`],
    };
  }

  const managerComment =
    body?.manager_comment != null ? String(body.manager_comment).trim() : null;
  if (managerComment && managerComment.length > 2000) {
    return { error: [400, 'manager_comment must be at most 2000 characters.'] };
  }

  const existing = await pool.query(
    `SELECT dr.id, dr.status, dr.employee_id
     FROM document_requests dr
     WHERE dr.id = $1
       AND dr.company_id = $2
       AND ${DOCUMENT_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$3')}`,
    [id, companyId, managerEmployeeId]
  );

  if (!existing.rows[0]) return { error: [404, 'Document request not found.'] };
  if (existing.rows[0].status !== 'pending') {
    return {
      error: [409, `Only pending document requests can be updated by a line manager. This request is already ${existing.rows[0].status}.`],
    };
  }

  const now = utcNowForPgTimestamp();
  const rejectionReason = newStatus === 'rejected' ? managerComment : null;

  await pool.query(
    `UPDATE document_requests
     SET status = $1::varchar,
         manager_comment = $2,
         manager_reviewed_by = $3,
         manager_reviewed_at = $4,
         review_stage = 'manager',
         rejection_reason = CASE WHEN $1::text = 'rejected' THEN $5 ELSE rejection_reason END,
         updated_at = $4
     WHERE id = $6 AND company_id = $7`,
    [newStatus, managerComment, managerEmployeeId, now, rejectionReason, id, companyId]
  );

  const document_request = await fetchDocumentRequestById(id, companyId);

  if (newStatus === 'manager_approved') {
    documentEmailNotification
      .notifyDocumentRequestManagerApproved(companyId, document_request)
      .catch((error) => {
        console.error('Document request manager approved notification error:', error);
      });
  } else if (newStatus === 'rejected') {
    documentEmailNotification
      .notifyDocumentRequestRejectedByManager(companyId, document_request, managerComment)
      .catch((error) => {
        console.error('Document request rejected by manager notification error:', error);
      });
  }

  return { document_request };
}

async function uploadFinalDocument(requestId, companyId, hrUserId, body) {
  const fileUrl = String(body.file_url || '').trim();
  const fileName = String(body.file_name || '').trim();
  if (!fileUrl) return { error: [400, 'file_url is required.'] };
  if (!fileName) return { error: [400, 'file_name is required.'] };

  const existing = await pool.query(
    'SELECT id, status FROM document_requests WHERE id = $1 AND company_id = $2',
    [requestId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document request not found.'] };
  if (existing.rows[0].status === 'rejected') {
    return { error: [400, 'Cannot upload a file for a rejected request.'] };
  }
  if (existing.rows[0].status === 'ready') {
    return { error: [400, 'This request already has a final document uploaded.'] };
  }
  if (!HR_ACTIONABLE_STATUSES.has(existing.rows[0].status)) {
    return {
      error: [409, `Cannot upload a file while document request is ${existing.rows[0].status}.`],
    };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE document_requests SET status = 'ready', file_url = $1, file_name = $2,
     rejection_reason = NULL, reviewed_by = $3, reviewed_at = $4, review_stage = NULL, updated_at = $4
     WHERE id = $5 AND company_id = $6`,
    [fileUrl, fileName, hrUserId, now, requestId, companyId]
  );

  const document_request = await fetchDocumentRequestById(requestId, companyId);

  documentEmailNotification
    .notifyDocumentRequestReady(companyId, document_request)
    .catch((error) => {
      console.error('Document request ready notification error:', error);
    });

  return { document_request };
}

async function cancelDocumentRequest(requestId, employeeId, companyId) {
  const existing = await pool.query(
    'SELECT id, employee_id, status FROM document_requests WHERE id = $1 AND company_id = $2',
    [requestId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document request not found.'] };
  if (Number(existing.rows[0].employee_id) !== employeeId) {
    return { error: [403, 'You can only cancel your own document requests.'] };
  }
  if (!EMPLOYEE_CANCELLABLE_STATUSES.has(existing.rows[0].status)) {
    return { error: [409, `Document request is already ${existing.rows[0].status}.`] };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE document_requests
     SET status = 'cancelled', updated_at = $1
     WHERE id = $2 AND company_id = $3`,
    [now, requestId, companyId]
  );

  return { document_request: await fetchDocumentRequestById(requestId, companyId, { employeeId }) };
}

async function rejectDocumentRequest(requestId, companyId, hrUserId, body) {
  const rejectionReason = String(body.rejection_reason || '').trim();
  if (!rejectionReason) return { error: [400, 'rejection_reason is required.'] };

  const existing = await pool.query(
    'SELECT id, status FROM document_requests WHERE id = $1 AND company_id = $2',
    [requestId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document request not found.'] };
  if (existing.rows[0].status === 'ready') {
    return { error: [400, 'Cannot reject a request that is already ready.'] };
  }
  if (!HR_ACTIONABLE_STATUSES.has(existing.rows[0].status)) {
    return {
      error: [409, `Cannot reject document request while status is ${existing.rows[0].status}.`],
    };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE document_requests SET status = 'rejected', rejection_reason = $1, file_url = NULL,
     file_name = NULL, reviewed_by = $2, reviewed_at = $3, review_stage = NULL, updated_at = $3
     WHERE id = $4 AND company_id = $5`,
    [rejectionReason, hrUserId, now, requestId, companyId]
  );

  const document_request = await fetchDocumentRequestById(requestId, companyId);

  documentEmailNotification
    .notifyDocumentRequestRejected(companyId, document_request, rejectionReason)
    .catch((error) => {
      console.error('Document request rejected notification error:', error);
    });

  return { document_request };
}

module.exports = {
  parsePositiveInt,
  createDocumentRequest,
  fetchDocumentRequestById,
  listMyDocumentRequests,
  listHrDocumentRequests,
  listTeamDocumentRequests,
  getTeamDocumentRequestById,
  updateTeamDocumentRequestStatus,
  uploadFinalDocument,
  rejectDocumentRequest,
  cancelDocumentRequest,
};
