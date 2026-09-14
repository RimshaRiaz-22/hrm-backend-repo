const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { parseUtcDateTime, toUtcIsoString, utcNowForPgTimestamp, toDateKey, toPgUtcTimestamp, parseOptionalDateInput } = require('../utils/dateTime');
const { parseListPagination, buildListPaginationMeta } = require('../services/pagination.service');
const { getEmployeeIdFromAuth, getEmployeeCompanyId } = require('../utils/employeeAuth');
const {
  getEmployeeAttendanceProfile,
  getPunchesForDate,
  snapshotOriginalCheckTimes,
} = require('./attendancePunch.service');
const { applyAttendanceCorrection } = require('./attendanceCorrection.service');
const {
  validateWfhDetails,
  assertWfhMonthlyLimit,
  assertNoConflictingWfhDates,
  loadWfhDetailsMap,
  applyWfhApproval,
  removeWfhAttendanceForDates,
  loadWfhDatesForRequest,
} = require('./wfhRequest.service');
const {
  createResignationRequest,
  loadResignationDetailsMap,
  applyResignationApproval,
  revertResignationApproval,
  canEmployeeCancelResignation,
  previewResignation,
  HR_RESIGNATION_APPROVE_ROLES,
} = require('./resignationRequest.service');
const {
  createLoanRequest,
  loadLoanDetailsMap,
  loadLoanPaymentsMap,
  applyLoanApproval,
  revertLoanApproval,
} = require('./loanRequest.service');
const {
  createExpenseRequest,
  loadExpenseDetailsMap,
  applyExpenseApproval,
  revertExpenseApproval,
} = require('./expenseRequest.service');
const { resolvePaidInForExpenseRequest } = require('./expenseCategory.service');
const {
  createPfTemporaryRequest,
  loadPfTemporaryDetailsMap,
  applyPfTemporaryApproval,
  revertPfTemporaryApproval,
} = require('./pfTemporaryRequest.service');
const {
  createPfPermanentRequest,
  loadPfPermanentDetailsMap,
  applyPfPermanentApproval,
  revertPfPermanentApproval,
} = require('./pfPermanentRequest.service');
const requestEmailNotification = require('./requestEmailNotification.service');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_TYPES = new Set([
  'attendance_correction',
  'wfh',
  'resignation',
  'document',
  'loan',
  'advance',
  'expense',
  'pf_temporary',
  'pf_permanent',
]);
// Human-readable labels shown in the UI ("Work From Home") vs. the raw request_type
// stored in the DB ("wfh") — needed so searching the label text actually matches.
const REQUEST_TYPE_SEARCH_LABELS = {
  attendance_correction: 'Attendance Correction',
  wfh: 'Work From Home',
  resignation: 'Resignation',
  document: 'Document',
  loan: 'Loan',
  advance: 'Advance',
  expense: 'Expense',
  pf_temporary: 'PF Temporary',
  pf_permanent: 'PF Permanent',
};
const REQUEST_STATUSES = new Set(['pending', 'manager_approved', 'approved', 'rejected', 'cancelled']);
const LM_SETTABLE_STATUSES = new Set(['manager_approved', 'rejected']);
const ADMIN_ACTIONABLE_STATUSES = new Set(['pending', 'manager_approved']);
const PHASE2_REQUEST_TYPES = new Set(['attendance_correction', 'wfh', 'resignation']);
const FINANCIAL_REQUEST_TYPES = new Set([
  'loan',
  'advance',
  'expense',
  'pf_temporary',
  'pf_permanent',
]);
const CREATABLE_REQUEST_TYPES = new Set([...PHASE2_REQUEST_TYPES, ...FINANCIAL_REQUEST_TYPES]);
const MANAGER_APPROVAL_REQUEST_TYPES = new Set([...CREATABLE_REQUEST_TYPES]);
const ADMIN_EDITABLE_REQUEST_TYPES = new Set([...PHASE2_REQUEST_TYPES, ...FINANCIAL_REQUEST_TYPES]);
const ADMIN_EDITABLE_STATUSES = new Set(['pending', 'approved', 'rejected']);

const HR_FINAL_APPROVE_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
]);

const HR_REQUEST_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
]);

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseOptionalDocumentUrl(value) {
  if (value === undefined || value === null) {
    return { value: null };
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return { value: null };
  }

  if (trimmed.length > 2048) {
    return { error: 'document_url must be at most 2048 characters.' };
  }

  const isHttpUrl = /^https?:\/\//i.test(trimmed);
  const isUploadPath = trimmed.startsWith('/uploads/');
  if (!isHttpUrl && !isUploadPath) {
    return { error: 'document_url must be a valid http(s) URL or uploads path.' };
  }

  return { value: trimmed };
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getRequestTypeFilterValue(query = {}) {
  const raw = query.request_type ?? query.type ?? '';
  return String(raw).trim().toLowerCase();
}

function appendRequestTypeFilter(conditions, params, requestType) {
  const normalized = String(requestType || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;

  if (normalized === 'financial') {
    conditions.push(`r.request_type IN ('loan', 'advance', 'pf_temporary', 'pf_permanent', 'expense')`);
    return null;
  }

  if (!REQUEST_TYPES.has(normalized)) {
    return { error: 'Invalid request_type filter.', status: 400 };
  }

  params.push(normalized);
  conditions.push(`r.request_type = $${params.length}`);
  return null;
}

function appendEmployeeSearchFilter(conditions, params, query, { includeRequestFields = false } = {}) {
  const unifiedSearch = String(query.search || '').trim();
  const employeeName = String(query.employee_name || query.name || '').trim();
  const employeeEmail = String(query.employee_email || query.email || '').trim();
  const searchTerm = unifiedSearch || employeeName || employeeEmail;

  if (!searchTerm) return;

  params.push(`%${searchTerm}%`);
  const searchIndex = params.length;
  const parts = [
    `e.first_name ILIKE $${searchIndex}`,
    `e.last_name ILIKE $${searchIndex}`,
    `CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex}`,
    `e.employee_code ILIKE $${searchIndex}`,
    `e.work_email ILIKE $${searchIndex}`,
  ];

  if (includeRequestFields) {
    parts.push(`r.request_type ILIKE $${searchIndex}`);

    const lowerSearchTerm = searchTerm.toLowerCase();
    const matchingTypeValues = Object.entries(REQUEST_TYPE_SEARCH_LABELS)
      .filter(([, label]) => label.toLowerCase().includes(lowerSearchTerm))
      .map(([value]) => value);
    if (matchingTypeValues.length > 0) {
      params.push(matchingTypeValues);
      parts.push(`r.request_type = ANY($${params.length}::text[])`);
    }
    parts.push(`COALESCE(acd.reason, '') ILIKE $${searchIndex}`);
    parts.push(`COALESCE(acd.correction_date::text, '') ILIKE $${searchIndex}`);
    parts.push(`EXISTS (
      SELECT 1 FROM wfh_request_details wfd
      WHERE wfd.request_id = r.id
        AND (
          COALESCE(wfd.reason, '') ILIKE $${searchIndex}
          OR COALESCE(wfd.work_plan, '') ILIKE $${searchIndex}
          OR wfd.wfh_date::text ILIKE $${searchIndex}
        )
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM resignation_details rd
      WHERE rd.request_id = r.id
        AND (
          COALESCE(rd.reason, '') ILIKE $${searchIndex}
          OR rd.last_intended_date::text ILIKE $${searchIndex}
          OR rd.calculated_last_working_date::text ILIKE $${searchIndex}
        )
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM loan_request_details lrd
      WHERE lrd.request_id = r.id
        AND (
          COALESCE(lrd.purpose, '') ILIKE $${searchIndex}
          OR lrd.amount::text ILIKE $${searchIndex}
        )
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM pf_temporary_request_details ptd
      WHERE ptd.request_id = r.id
        AND (
          COALESCE(ptd.purpose, '') ILIKE $${searchIndex}
          OR ptd.amount::text ILIKE $${searchIndex}
        )
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM pf_permanent_request_details ppd
      WHERE ppd.request_id = r.id
        AND (
          COALESCE(ppd.purpose, '') ILIKE $${searchIndex}
          OR ppd.amount::text ILIKE $${searchIndex}
        )
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM expense_request_details erd
      WHERE erd.request_id = r.id
        AND (
          erd.category ILIKE $${searchIndex}
          OR erd.total_amount::text ILIKE $${searchIndex}
        )
    )`);
  }

  conditions.push(`(${parts.join(' OR ')})`);
}

function appendRequestDateFilter(conditions, params, query) {
  const dateRaw = String(query.date || query.request_date || '').trim();
  if (!dateRaw) return null;

  const parsed = parseOptionalDateInput(dateRaw, 'date');
  if (parsed.error) return { error: parsed.error, status: 400 };
  if (!parsed.value) return null;

  params.push(parsed.value);
  const dateIndex = params.length;
  const requestType = getRequestTypeFilterValue(query);

  if (requestType === 'attendance_correction') {
    conditions.push(`acd.correction_date = $${dateIndex}::date`);
  } else if (requestType === 'wfh') {
    conditions.push(`EXISTS (
      SELECT 1 FROM wfh_request_details wfd
      WHERE wfd.request_id = r.id AND wfd.wfh_date = $${dateIndex}::date
    )`);
  } else if (requestType === 'resignation') {
    conditions.push(`EXISTS (
      SELECT 1 FROM resignation_details rd
      WHERE rd.request_id = r.id
        AND (
          rd.last_intended_date = $${dateIndex}::date
          OR rd.calculated_last_working_date = $${dateIndex}::date
        )
    )`);
  } else if (requestType) {
    conditions.push(`(r.submitted_at AT TIME ZONE 'UTC')::date = $${dateIndex}::date`);
  } else {
    conditions.push(`(
      acd.correction_date = $${dateIndex}::date
      OR EXISTS (
        SELECT 1 FROM wfh_request_details wfd
        WHERE wfd.request_id = r.id AND wfd.wfh_date = $${dateIndex}::date
      )
      OR EXISTS (
        SELECT 1 FROM resignation_details rd
        WHERE rd.request_id = r.id
          AND (
            rd.last_intended_date = $${dateIndex}::date
            OR rd.calculated_last_working_date = $${dateIndex}::date
          )
      )
      OR (r.submitted_at AT TIME ZONE 'UTC')::date = $${dateIndex}::date
    )`);
  }

  return null;
}

function appendAdminListFilters(conditions, params, query) {
  appendEmployeeSearchFilter(conditions, params, query, { includeRequestFields: true });
  return appendRequestDateFilter(conditions, params, query);
}

function appendMyRequestListFilters(conditions, params, query) {
  appendEmployeeSearchFilter(conditions, params, query, { includeRequestFields: true });
  return appendRequestDateFilter(conditions, params, query);
}

const REQUEST_LIST_FROM = `
  FROM requests r
  JOIN employees e ON e.id = r.employee_id
  LEFT JOIN attendance_correction_details acd ON acd.request_id = r.id
  LEFT JOIN employees mgr_e ON mgr_e.id = r.manager_reviewed_by AND mgr_e.company_id = r.company_id
  LEFT JOIN users hr_u ON hr_u.id = r.reviewed_by
`;

const REQUEST_LIST_SELECT = `
  SELECT r.*,
         e.first_name || ' ' || e.last_name AS employee_name,
         e.employee_code,
         e.work_email AS employee_email,
         acd.correction_date,
         acd.original_check_in,
         acd.original_check_out,
         acd.corrected_check_in,
         acd.corrected_check_out,
         acd.reason,
         mgr_e.first_name AS manager_reviewer_first_name,
         mgr_e.last_name AS manager_reviewer_last_name,
         mgr_e.work_email AS manager_reviewer_email,
         mgr_e.employee_code AS manager_reviewer_code,
         hr_u.full_name AS hr_reviewer_name,
         hr_u.email AS hr_reviewer_email
  ${REQUEST_LIST_FROM}
`;

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
  if (status === 'approved') {
    if (hrReviewedBy) {
      return {
        type: 'admin',
        id: hrReviewedBy.id,
        name: hrReviewedBy.name,
        email: hrReviewedBy.email,
      };
    }
    if (managerReviewedBy) {
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

  if (status === 'manager_approved' && managerReviewedBy) {
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

  if (status === 'rejected' || status === 'cancelled') {
    if (hrReviewedBy) {
      return {
        type: 'admin',
        id: hrReviewedBy.id,
        name: hrReviewedBy.name,
        email: hrReviewedBy.email,
      };
    }
    if (managerReviewedBy) {
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
  }

  return null;
}

function mapRequestRow(row) {
  const managerReviewedBy = mapManagerReviewerSummary(row);
  const hrReviewedBy = mapHrReviewerSummary(row);
  const base = {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_code: row.employee_code || null,
    employee_email: row.employee_email || null,
    request_type: row.request_type,
    status: row.status,
    submitted_at: toUtcIsoString(row.submitted_at),
    reviewed_by: row.reviewed_by ? Number(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    hr_comment: row.hr_comment || null,
    manager_comment: row.manager_comment || null,
    document_url: row.document_url || null,
    review_stage: row.review_stage || null,
    manager_reviewed_by: managerReviewedBy,
    manager_reviewed_at: row.manager_reviewed_at ? toUtcIsoString(row.manager_reviewed_at) : null,
    hr_reviewed_by: hrReviewedBy,
    hr_reviewed_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    approved_by: resolveApprovedBySummary(row.status, managerReviewedBy, hrReviewedBy),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };

  if (row.request_type === 'attendance_correction') {
    base.details = {
      correction_date: row.correction_date ? toDateKey(row.correction_date) : null,
      original_check_in: row.original_check_in ? toUtcIsoString(row.original_check_in) : null,
      original_check_out: row.original_check_out ? toUtcIsoString(row.original_check_out) : null,
      corrected_check_in: row.corrected_check_in ? toUtcIsoString(row.corrected_check_in) : null,
      corrected_check_out: row.corrected_check_out ? toUtcIsoString(row.corrected_check_out) : null,
      reason: row.reason || null,
    };
  }

  return base;
}

async function enrichRequestItems(items) {
  const wfhIds = items.filter((item) => item.request_type === 'wfh').map((item) => item.id);
  const resignationIds = items
    .filter((item) => item.request_type === 'resignation')
    .map((item) => item.id);
  const loanIds = items
    .filter((item) => item.request_type === 'loan' || item.request_type === 'advance')
    .map((item) => item.id);
  const pfTemporaryIds = items
    .filter((item) => item.request_type === 'pf_temporary')
    .map((item) => item.id);
  const pfPermanentIds = items
    .filter((item) => item.request_type === 'pf_permanent')
    .map((item) => item.id);
  const expenseIds = items.filter((item) => item.request_type === 'expense').map((item) => item.id);

  const [
    wfhDetailsMap,
    resignationDetailsMap,
    loanDetailsMap,
    pfTemporaryDetailsMap,
    pfPermanentDetailsMap,
    expenseDetailsMap,
  ] = await Promise.all([
    loadWfhDetailsMap(wfhIds),
    loadResignationDetailsMap(resignationIds),
    loadLoanDetailsMap(loanIds),
    loadPfTemporaryDetailsMap(pfTemporaryIds),
    loadPfPermanentDetailsMap(pfPermanentIds),
    loadExpenseDetailsMap(expenseIds),
  ]);

  const loanRecordIds = [];
  for (const details of loanDetailsMap.values()) {
    if (details?.loan?.id) loanRecordIds.push(details.loan.id);
  }
  for (const details of pfTemporaryDetailsMap.values()) {
    if (details?.recovery?.id) loanRecordIds.push(details.recovery.id);
  }
  const loanPaymentsMap = await loadLoanPaymentsMap(loanRecordIds);

  const enriched = items.map((item) => {
    if (item.request_type === 'wfh') {
      const details = wfhDetailsMap.get(item.id) || { dates: [], reason: null, work_plan: null };
      return { ...item, details };
    }
    if (item.request_type === 'resignation') {
      const details = resignationDetailsMap.get(item.id) || null;
      return { ...item, details };
    }
    if (item.request_type === 'loan' || item.request_type === 'advance') {
      const details = loanDetailsMap.get(item.id) || null;
      if (details?.loan?.id) {
        details.payments = loanPaymentsMap.get(details.loan.id) || [];
      }
      return { ...item, details };
    }
    if (item.request_type === 'pf_temporary') {
      const details = pfTemporaryDetailsMap.get(item.id) || null;
      if (details?.recovery?.id) {
        details.payments = loanPaymentsMap.get(details.recovery.id) || [];
      }
      return { ...item, details };
    }
    if (item.request_type === 'pf_permanent') {
      const details = pfPermanentDetailsMap.get(item.id) || null;
      return { ...item, details };
    }
    if (item.request_type === 'expense') {
      const details = expenseDetailsMap.get(item.id) || null;
      return { ...item, details };
    }
    return item;
  });

  return enriched;
}

async function fetchMappedRequest(requestId) {
  const result = await pool.query(`${REQUEST_LIST_SELECT} WHERE r.id = $1`, [requestId]);
  if (!result.rows[0]) return null;
  const [item] = await enrichRequestItems([mapRequestRow(result.rows[0])]);
  return item;
}

function supportsManagerApproval(requestType) {
  return MANAGER_APPROVAL_REQUEST_TYPES.has(String(requestType || '').trim().toLowerCase());
}

function notifyRequestStatusEmails(action, requestItem, comment) {
  if (!requestItem) return;

  const companyId = Number(requestItem.company_id);
  if (action === 'submitted') {
    requestEmailNotification.notifyRequestSubmitted(companyId, requestItem).catch((error) => {
      console.error(`${requestItem.request_type} submitted notification error:`, error);
    });
    return;
  }
  if (action === 'approved') {
    requestEmailNotification.notifyRequestApproved(companyId, requestItem).catch((error) => {
      console.error(`${requestItem.request_type} approved notification error:`, error);
    });
    return;
  }
  if (action === 'rejected') {
    requestEmailNotification.notifyRequestRejected(companyId, requestItem, comment).catch((error) => {
      console.error(`${requestItem.request_type} rejected notification error:`, error);
    });
  }
}

async function getReviewerContext(auth) {
  const result = await pool.query(
    `SELECT id, email, role, company_id, is_active
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: 'Authenticated user not found.' };
  const user = result.rows[0];
  if (!user.is_active) return { error: 'Your account is inactive.' };
  if (!HR_REQUEST_ROLES.has(user.role)) {
    return { error: 'You do not have permission to review requests.' };
  }
  if (!user.company_id && user.role !== USER_ROLES.SUPER_ADMIN) {
    return { error: 'Your account must be linked to a company.' };
  }
  return { user };
}

function validateAttendanceCorrectionDetails(details) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const correctionDateParsed = parseOptionalDateInput(details.correction_date, 'details.correction_date');
  if (correctionDateParsed.error) {
    return { error: correctionDateParsed.error };
  }
  const correctionDate = correctionDateParsed.value;
  if (!correctionDate) {
    return { error: 'details.correction_date is required.' };
  }

  if (correctionDate > getTodayDateString()) {
    return { error: 'Correction date cannot be in the future.' };
  }

  const correctedCheckIn = details.corrected_check_in
    ? parseUtcDateTime(details.corrected_check_in)
    : null;

  const correctedCheckOut = details.corrected_check_out
    ? parseUtcDateTime(details.corrected_check_out)
    : null;

  if (!correctedCheckIn && !correctedCheckOut) {
    return {
      error:
        'Either details.corrected_check_in or details.corrected_check_out is required.',
    };
  }

  if (details.corrected_check_in && !correctedCheckIn) {
    return {
      error: 'details.corrected_check_in must be a valid ISO date/time.',
    };
  }

  if (details.corrected_check_out && !correctedCheckOut) {
    return {
      error: 'details.corrected_check_out must be a valid ISO date/time.',
    };
  }

  if (
    correctedCheckIn &&
    correctedCheckOut &&
    correctedCheckOut.getTime() <= correctedCheckIn.getTime()
  ) {
    return {
      error: 'Corrected check-out must be after corrected check-in.',
    };
  }

  const reason = String(details.reason || '').trim();
  if (!reason) {
    return { error: 'details.reason is required.' };
  }

  if (reason.length > 2000) {
    return {
      error: 'details.reason must be at most 2000 characters.',
    };
  }

  return {
    correctionDate,
    correctedCheckIn,
    correctedCheckOut,
    reason,
  };
}

async function createAttendanceCorrectionRequest(client, {
  auth,
  employeeId,
  companyId,
  requestType,
  details,
}) {
  const detailsValidation = validateAttendanceCorrectionDetails(details);
  if (detailsValidation.error) {
    return { error: detailsValidation.error, status: 400 };
  }

  const existingPending = await client.query(
    `SELECT acd.corrected_check_in, acd.corrected_check_out
     FROM requests r
     JOIN attendance_correction_details acd ON acd.request_id = r.id
     WHERE r.employee_id = $1
       AND r.request_type = 'attendance_correction'
       AND r.status = 'pending'
       AND acd.correction_date = $2`,
    [employeeId, detailsValidation.correctionDate]
  );

  const wantsCheckIn = !!detailsValidation.correctedCheckIn;
  const wantsCheckOut = !!detailsValidation.correctedCheckOut;

  for (const row of existingPending.rows) {
    if (wantsCheckIn && row.corrected_check_in) {
      return { error: 'Your check-in correction request is already pending.', status: 409 };
    }
    if (wantsCheckOut && row.corrected_check_out) {
      return { error: 'Your check-out correction request is already pending.', status: 409 };
    }
  }

  const punches = await getPunchesForDate(client, employeeId, detailsValidation.correctionDate);
  const originals = snapshotOriginalCheckTimes(punches);

  const requestResult = await client.query(
    `INSERT INTO requests (company_id, employee_id, request_type, status, submitted_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id`,
    [companyId, employeeId, requestType, utcNowForPgTimestamp()]
  );
  const requestId = Number(requestResult.rows[0].id);

  await client.query(
    `INSERT INTO attendance_correction_details (
       request_id, correction_date, original_check_in, original_check_out,
       corrected_check_in, corrected_check_out, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      requestId,
      detailsValidation.correctionDate,
      toPgUtcTimestamp(originals.original_check_in, { fromDatabase: true }),
      toPgUtcTimestamp(originals.original_check_out, { fromDatabase: true }),
      toPgUtcTimestamp(detailsValidation.correctedCheckIn),
      toPgUtcTimestamp(detailsValidation.correctedCheckOut),
      detailsValidation.reason,
    ]
  );

  return { requestId };
}

async function createWfhRequest(client, { employeeId, companyId, requestType, details }) {
  const detailsValidation = validateWfhDetails(details);
  if (detailsValidation.error) {
    return { error: detailsValidation.error, status: 400 };
  }

  const conflict = await assertNoConflictingWfhDates(
    client,
    employeeId,
    detailsValidation.dates
  );
  if (conflict) return conflict;

  const limitCheck = await assertWfhMonthlyLimit(client, {
    employeeId,
    companyId,
    dates: detailsValidation.dates,
  });
  if (limitCheck.error) return limitCheck;

  const requestResult = await client.query(
    `INSERT INTO requests (
       company_id, employee_id, request_type, status, submitted_at, review_stage
     )
     VALUES ($1, $2, $3, 'pending', $4, NULL)
     RETURNING id`,
    [companyId, employeeId, requestType, utcNowForPgTimestamp()]
  );
  const requestId = Number(requestResult.rows[0].id);

  for (const wfhDate of detailsValidation.dates) {
    await client.query(
      `INSERT INTO wfh_request_details (request_id, wfh_date, reason, work_plan)
       VALUES ($1, $2, $3, $4)`,
      [requestId, wfhDate, detailsValidation.reason, detailsValidation.workPlan]
    );
  }

  return { requestId };
}

async function revertApprovedRequestEffects(client, row, requestId) {
  const employeeId = Number(row.employee_id);

  if (row.request_type === 'attendance_correction') {
    const correctionDate = row.correction_date ? toDateKey(row.correction_date) : null;
    if (correctionDate) {
      await client.query(
        `DELETE FROM attendance_punches
         WHERE employee_id = $1
           AND attendance_date = $2
           AND remarks = $3`,
        [employeeId, correctionDate, `attendance_correction_request:${requestId}`]
      );
    }
    return;
  }

  if (row.request_type === 'wfh') {
    const dates = await loadWfhDatesForRequest(client, requestId);
    await removeWfhAttendanceForDates(client, employeeId, requestId, dates);
    return;
  }

  if (row.request_type === 'resignation') {
    await revertResignationApproval(client, { employeeId, requestId });
    return;
  }

  if (row.request_type === 'loan' || row.request_type === 'advance') {
    await revertLoanApproval(client, requestId);
    return;
  }

  if (row.request_type === 'pf_temporary') {
    await revertPfTemporaryApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
    });
    return;
  }

  if (row.request_type === 'pf_permanent') {
    await revertPfPermanentApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
      recordedBy: null,
    });
    return;
  }

  if (row.request_type === 'expense') {
    await revertExpenseApproval(client, requestId);
  }
}

async function applyApprovedRequestEffects(client, row, requestId, reviewerId, options = {}) {
  const employeeId = Number(row.employee_id);

  if (row.request_type === 'attendance_correction') {
    await applyAttendanceCorrection(client, {
      employeeId,
      correctionDate: toDateKey(row.correction_date),
      correctedCheckIn: row.corrected_check_in,
      correctedCheckOut: row.corrected_check_out,
      reviewedBy: reviewerId,
      requestId,
    });
    return;
  }

  if (row.request_type === 'wfh') {
    await applyWfhApproval(client, {
      employeeId,
      requestId,
      reviewedBy: reviewerId,
    });
    return;
  }

  if (row.request_type === 'resignation') {
    await applyResignationApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
      reviewerId,
    });
    return;
  }

  if (row.request_type === 'loan' || row.request_type === 'advance') {
    await applyLoanApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
    });
    return;
  }

  if (row.request_type === 'pf_temporary') {
    await applyPfTemporaryApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
      recordedBy: reviewerId,
    });
    return;
  }

  if (row.request_type === 'pf_permanent') {
    await applyPfPermanentApproval(client, {
      employeeId,
      companyId: Number(row.company_id),
      requestId,
      recordedBy: reviewerId,
    });
    return;
  }

  if (row.request_type === 'expense') {
    const paidInResolution = await resolvePaidInForExpenseRequest(
      client,
      requestId,
      options.paid_in
    );
    if (paidInResolution.error) {
      return { error: paidInResolution.error };
    }
    await applyExpenseApproval(client, requestId, {
      paid_in: paidInResolution.paidIn,
      status_date: options.status_date,
    });
    return;
  }

  return null;
}

async function updateRequest(auth, requestId, body) {
  const reviewerCtx = await getReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const newStatus = String(body?.status || '').trim().toLowerCase();
  if (!ADMIN_EDITABLE_STATUSES.has(newStatus)) {
    return { error: 'status must be pending, approved, or rejected.', status: 400 };
  }

  const hrComment = String(body?.hr_comment || '').trim();
  if (newStatus === 'rejected' && !hrComment) {
    return { error: 'hr_comment is required when status is rejected.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const row = await getRequestForReview(client, id, reviewerCtx.user);
    if (!row) {
      await client.query('ROLLBACK');
      return { error: 'Request not found.', status: 404 };
    }
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { error: 'Cancelled requests cannot be updated.', status: 409 };
    }
    if (!ADMIN_EDITABLE_REQUEST_TYPES.has(row.request_type)) {
      await client.query('ROLLBACK');
      return { error: 'This request type cannot be updated yet.', status: 400 };
    }

    const previousStatus = row.status;
    if (previousStatus === newStatus) {
      await client.query('ROLLBACK');
      return { error: 'Request already has this status.', status: 409 };
    }

    const reviewerId = reviewerCtx.user.id;
    const now = utcNowForPgTimestamp();

    if (previousStatus === 'approved' && newStatus !== 'approved') {
      await revertApprovedRequestEffects(client, row, id);
    }

    if (newStatus === 'pending') {
      await client.query(
        `UPDATE requests
         SET status = 'pending',
             reviewed_by = NULL,
             reviewed_at = NULL,
             hr_comment = NULL,
             review_stage = NULL,
             manager_reviewed_by = NULL,
             manager_reviewed_at = NULL,
             updated_at = $1
         WHERE id = $2`,
        [now, id]
      );
    } else if (newStatus === 'approved') {
      if (row.request_type === 'expense') {
        const paidInResolution = await resolvePaidInForExpenseRequest(
          client,
          id,
          body?.paid_in
        );
        if (paidInResolution.error) {
          await client.query('ROLLBACK');
          return { error: paidInResolution.error, status: 400 };
        }
        // Persist resolved value so applyApprovedRequestEffects uses the same paid_in
        body.paid_in = paidInResolution.paidIn;
      }

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             hr_comment = NULL,
             review_stage = NULL,
             updated_at = $2
         WHERE id = $3`,
        [reviewerId, now, id]
      );

      if (previousStatus !== 'approved') {
        const effectResult = await applyApprovedRequestEffects(client, row, id, reviewerId, {
          paid_in: body?.paid_in,
          status_date: body?.status_date,
        });
        if (effectResult?.error) {
          await client.query('ROLLBACK');
          return { error: effectResult.error, status: 400 };
        }
      }
    } else if (newStatus === 'rejected') {
      await client.query(
        `UPDATE requests
         SET status = 'rejected',
             reviewed_by = $1,
             reviewed_at = $2,
             hr_comment = $3,
             review_stage = NULL,
             updated_at = $2
         WHERE id = $4`,
        [reviewerId, now, hrComment, id]
      );
    }

    await client.query('COMMIT');

    const updated = await fetchMappedRequest(id);
    if (newStatus === 'approved') {
      notifyRequestStatusEmails('approved', updated);
    } else if (newStatus === 'rejected') {
      notifyRequestStatusEmails('rejected', updated, hrComment);
    }
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createRequest(auth, body) {
  const requestType = String(body?.request_type || '').trim().toLowerCase();
  if (!REQUEST_TYPES.has(requestType)) {
    return { error: 'Invalid request_type.' };
  }
  if (!CREATABLE_REQUEST_TYPES.has(requestType)) {
    return { error: 'This request type is not available yet.' };
  }

  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const companyId = await getEmployeeCompanyId(employeeId);
  if (!companyId) {
    return { error: 'Employee company not found.', status: 404 };
  }

  const documentUrlResult = parseOptionalDocumentUrl(body?.document_url);
  if (documentUrlResult.error) {
    return { error: documentUrlResult.error, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let createResult;
    if (requestType === 'attendance_correction') {
      createResult = await createAttendanceCorrectionRequest(client, {
        auth,
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'wfh') {
      createResult = await createWfhRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'resignation') {
      createResult = await createResignationRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'loan' || requestType === 'advance') {
      createResult = await createLoanRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'expense') {
      createResult = await createExpenseRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'pf_temporary') {
      createResult = await createPfTemporaryRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    } else if (requestType === 'pf_permanent') {
      createResult = await createPfPermanentRequest(client, {
        employeeId,
        companyId,
        requestType,
        details: body?.details,
      });
    }

    if (createResult?.error) {
      await client.query('ROLLBACK');
      return { error: createResult.error, status: createResult.status || 400 };
    }

    if (documentUrlResult.value) {
      await client.query(
        `UPDATE requests
         SET document_url = $1, updated_at = $2
         WHERE id = $3`,
        [documentUrlResult.value, utcNowForPgTimestamp(), createResult.requestId]
      );
    }

    await client.query('COMMIT');
    const created = await fetchMappedRequest(createResult.requestId);
    notifyRequestStatusEmails('submitted', created);
    return { data: created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listMyRequests(auth, query = {}) {
  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const requestType = getRequestTypeFilterValue(query);
  const status = String(query.status || '').trim().toLowerCase();

  const conditions = ['r.employee_id = $1'];
  const params = [employeeId];

  const typeFilterError = appendRequestTypeFilter(conditions, params, requestType);
  if (typeFilterError) {
    return typeFilterError;
  }

  const listFilterError = appendMyRequestListFilters(conditions, params, query);
  if (listFilterError) {
    return listFilterError;
  }

  if (status && status !== 'all') {
    if (!REQUEST_STATUSES.has(status)) {
      return { error: 'Invalid status filter.', status: 400 };
    }
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');

  let listSql = `${REQUEST_LIST_SELECT} WHERE ${whereClause} ORDER BY r.submitted_at DESC, r.id DESC`;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const [countResult, listResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total ${REQUEST_LIST_FROM} WHERE ${whereClause}`, params),
    pool.query(listSql, listParams),
  ]);
  const total = countResult.rows[0].total;
  const items = await enrichRequestItems(listResult.rows.map(mapRequestRow));

  return {
    data: {
      items,
      pagination: pagination.noPagination
        ? null
        : buildListPaginationMeta(total, pagination),
    },
  };
}

async function listAdminRequests(auth, query = {}, options = {}) {
  const reviewer = await getReviewerContext(auth);
  if (reviewer.error) {
    return { error: reviewer.error, status: 403 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const requestType = getRequestTypeFilterValue(query);

  const conditions = [];
  const params = [];

  const typeFilterError = appendRequestTypeFilter(conditions, params, requestType);
  if (typeFilterError) {
    return typeFilterError;
  }

  const listFilterError = appendAdminListFilters(conditions, params, query);
  if (listFilterError) {
    return listFilterError;
  }

  const statusFilter = String(
    query.status || options.defaultStatus || 'all'
  )
    .trim()
    .toLowerCase();

  if (statusFilter && statusFilter !== 'all') {
    if (!REQUEST_STATUSES.has(statusFilter)) {
      return { error: 'Invalid status filter.', status: 400 };
    }
    params.push(statusFilter);
    conditions.push(`r.status = $${params.length}`);
  }

  if (reviewer.user.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(reviewer.user.company_id);
    conditions.push(`r.company_id = $${params.length}`);
  }

  const whereClause = conditions.length ? conditions.join(' AND ') : 'TRUE';
  const orderDirection = statusFilter === 'pending' ? 'ASC' : 'DESC';

  let listSql = `${REQUEST_LIST_SELECT} WHERE ${whereClause} ORDER BY r.submitted_at ${orderDirection}, r.id ${orderDirection}`;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const [countResult, listResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total ${REQUEST_LIST_FROM} WHERE ${whereClause}`, params),
    pool.query(listSql, listParams),
  ]);
  const total = countResult.rows[0].total;
  const items = await enrichRequestItems(listResult.rows.map(mapRequestRow));

  return {
    data: {
      items,
      pagination: pagination.noPagination
        ? null
        : buildListPaginationMeta(total, pagination),
    },
  };
}

async function listPendingRequests(auth, query = {}) {
  const status = String(query.status ?? '').trim().toLowerCase();
  return listAdminRequests(auth, {
    ...query,
    status: status || 'all',
  });
}

async function getRequestForReview(client, requestId, reviewer) {
  const params = [requestId];
  let companyFilter = '';
  if (reviewer.role !== USER_ROLES.SUPER_ADMIN) {
    params.push(reviewer.company_id);
    companyFilter = ` AND r.company_id = $${params.length}`;
  }

  const result = await client.query(
    `${REQUEST_LIST_SELECT}
     WHERE r.id = $1${companyFilter}
     FOR UPDATE OF r`,
    params
  );
  return result.rows[0] || null;
}

const REQUEST_TEAM_ACCESS_SQL = `EXISTS (
  SELECT 1 FROM employee_line_managers elm
  WHERE elm.company_id = r.company_id
    AND elm.employee_id = r.employee_id
    AND elm.manager_id = $MANAGER_PARAM$
)`;

function appendManagerApprovalTypeFilter(conditions, params, requestType) {
  const normalized = String(requestType || '').trim().toLowerCase();
  if (normalized && normalized !== 'all') {
    if (normalized === 'financial') {
      conditions.push(`r.request_type IN ('loan', 'advance', 'pf_temporary', 'pf_permanent', 'expense')`);
      return null;
    }
    if (!MANAGER_APPROVAL_REQUEST_TYPES.has(normalized)) {
      return { error: 'Invalid request_type filter.', status: 400 };
    }
    params.push(normalized);
    conditions.push(`r.request_type = $${params.length}`);
    return null;
  }

  const typePlaceholders = Array.from(MANAGER_APPROVAL_REQUEST_TYPES)
    .map((type) => `'${type}'`)
    .join(', ');
  conditions.push(`r.request_type IN (${typePlaceholders})`);
  return null;
}

/** GET /v1/requests/team — line manager lists direct reports' requests. */
async function listTeamRequests(auth, query = {}, options = {}) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: 'Employee company not found.', status: 404 };
  }

  const pagination = parseListPagination(query);
  if (pagination.error) {
    return { error: pagination.error, status: 400 };
  }

  const params = [companyId, managerEmployeeId];
  const conditions = [
    `r.company_id = $1`,
    REQUEST_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$2'),
  ];

  const requestType = options.forceRequestType || getRequestTypeFilterValue(query);
  const typeFilterError = appendManagerApprovalTypeFilter(conditions, params, requestType);
  if (typeFilterError) {
    return typeFilterError;
  }

  const listFilterError = appendAdminListFilters(conditions, params, query);
  if (listFilterError) {
    return listFilterError;
  }

  const status = String(query.status || '').trim().toLowerCase();
  if (status && status !== 'all') {
    if (!REQUEST_STATUSES.has(status)) {
      return { error: 'Invalid status filter.', status: 400 };
    }
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');
  const orderDirection = status === 'pending' ? 'ASC' : 'DESC';

  let listSql = `${REQUEST_LIST_SELECT} WHERE ${whereClause} ORDER BY r.submitted_at ${orderDirection}, r.id ${orderDirection}`;
  const listParams = [...params];

  if (!pagination.noPagination) {
    listParams.push(pagination.pagination.limit, pagination.pagination.offset);
    listSql += ` LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;
  }

  const [countResult, listResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total ${REQUEST_LIST_FROM} WHERE ${whereClause}`, params),
    pool.query(listSql, listParams),
  ]);
  const total = countResult.rows[0].total;
  const items = await enrichRequestItems(listResult.rows.map(mapRequestRow));

  return {
    data: {
      items,
      pagination: pagination.noPagination ? null : buildListPaginationMeta(total, pagination),
    },
  };
}

/** GET /v1/requests/team/:id — line manager views a direct report's request. */
async function getTeamRequestById(auth, requestId, options = {}) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: 'Employee company not found.', status: 404 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const forcedType = options.forceRequestType;
  const typeFilterSql = forcedType ? ` AND r.request_type = $4` : '';
  const typeFilterSqlWithSupport = forcedType
    ? typeFilterSql
    : ` AND r.request_type = ANY($4::text[])`;
  const queryParams = forcedType
    ? [id, companyId, managerEmployeeId, forcedType]
    : [id, companyId, managerEmployeeId, Array.from(MANAGER_APPROVAL_REQUEST_TYPES)];

  const result = await pool.query(
    `${REQUEST_LIST_SELECT}
     WHERE r.id = $1
       AND r.company_id = $2
       AND ${REQUEST_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$3')}${typeFilterSqlWithSupport}`,
    queryParams
  );
  if (!result.rows[0]) {
    return { error: 'Request not found.', status: 404 };
  }

  const [item] = await enrichRequestItems([mapRequestRow(result.rows[0])]);
  return { data: item };
}

/** PATCH /v1/requests/team/:id/status — line manager approves or rejects a pending request. */
async function updateTeamRequestStatus(auth, requestId, body = {}, options = {}) {
  const managerEmployeeId = await getEmployeeIdFromAuth(auth);
  if (!managerEmployeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }
  const companyId = await getEmployeeCompanyId(managerEmployeeId);
  if (!companyId) {
    return { error: 'Employee company not found.', status: 404 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const newStatus = String(body?.status || '').trim().toLowerCase();
  if (!LM_SETTABLE_STATUSES.has(newStatus)) {
    return {
      error: `status must be one of: ${Array.from(LM_SETTABLE_STATUSES).join(', ')}.`,
      status: 400,
    };
  }

  const managerComment = body?.manager_comment != null ? String(body.manager_comment).trim() : null;
  if (managerComment && managerComment.length > 2000) {
    return { error: 'manager_comment must be at most 2000 characters.', status: 400 };
  }

  const forcedType = options.forceRequestType;
  const typeFilterSql = forcedType ? ` AND r.request_type = $4` : '';
  const typeFilterSqlWithSupport = forcedType
    ? typeFilterSql
    : ` AND r.request_type = ANY($4::text[])`;
  const queryParams = forcedType
    ? [id, companyId, managerEmployeeId, forcedType]
    : [id, companyId, managerEmployeeId, Array.from(MANAGER_APPROVAL_REQUEST_TYPES)];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT r.id, r.status, r.request_type
       FROM requests r
       WHERE r.id = $1
         AND r.company_id = $2
         AND ${REQUEST_TEAM_ACCESS_SQL.replace('$MANAGER_PARAM$', '$3')}${typeFilterSqlWithSupport}
       FOR UPDATE OF r`,
      queryParams
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'Request not found.', status: 404 };
    }
    if (!supportsManagerApproval(result.rows[0].request_type)) {
      await client.query('ROLLBACK');
      return { error: 'This request type does not support manager approval.', status: 400 };
    }
    if (result.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return {
        error: `Only pending requests can be updated by a line manager. This request is already ${result.rows[0].status}.`,
        status: 409,
      };
    }

    const now = utcNowForPgTimestamp();
    await client.query(
      `UPDATE requests
       SET status = $1,
           manager_comment = $2,
           manager_reviewed_by = $3,
           manager_reviewed_at = $4,
           review_stage = 'manager',
           updated_at = $4
       WHERE id = $5`,
      [newStatus, managerComment, managerEmployeeId, now, id]
    );

    await client.query('COMMIT');

    const updated = await fetchMappedRequest(id);
    if (newStatus === 'manager_approved') {
      requestEmailNotification
        .notifyRequestManagerApproved(companyId, updated)
        .catch((error) => {
          console.error(`${updated.request_type} manager approved notification error:`, error);
        });
    } else if (newStatus === 'rejected') {
      requestEmailNotification
        .notifyRequestRejectedByManager(companyId, updated, managerComment)
        .catch((error) => {
          console.error(`${updated.request_type} rejected by manager notification error:`, error);
        });
    }
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Backward-compatible attendance correction team endpoints. */
async function listTeamAttendanceCorrectionRequests(auth, query = {}) {
  return listTeamRequests(auth, query, { forceRequestType: 'attendance_correction' });
}

async function getTeamAttendanceCorrectionRequestById(auth, requestId) {
  return getTeamRequestById(auth, requestId, { forceRequestType: 'attendance_correction' });
}

async function updateTeamAttendanceCorrectionStatus(auth, requestId, body = {}) {
  return updateTeamRequestStatus(auth, requestId, body, { forceRequestType: 'attendance_correction' });
}

async function approveRequest(auth, requestId, body = {}) {
  const reviewerCtx = await getReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const row = await getRequestForReview(client, id, reviewerCtx.user);
    if (!row) {
      await client.query('ROLLBACK');
      return { error: 'Request not found.', status: 404 };
    }
    const canApprove = supportsManagerApproval(row.request_type)
      ? ADMIN_ACTIONABLE_STATUSES.has(row.status)
      : row.status === 'pending';
    if (!canApprove) {
      await client.query('ROLLBACK');
      return { error: `Request is already ${row.status}.`, status: 409 };
    }

    const now = utcNowForPgTimestamp();
    const reviewerId = reviewerCtx.user.id;
    const reviewerRole = reviewerCtx.user.role;

    if (row.request_type === 'attendance_correction') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return {
          error: 'Only HR or admin can give final approval for attendance correction requests.',
          status: 403,
        };
      }

      await applyAttendanceCorrection(client, {
        employeeId: Number(row.employee_id),
        correctionDate: toDateKey(row.correction_date),
        correctedCheckIn: row.corrected_check_in,
        correctedCheckOut: row.corrected_check_out,
        reviewedBy: reviewerId,
        requestId: id,
      });

      // manager_reviewed_by/manager_reviewed_at are intentionally left untouched here
      // so the manager-stage audit trail survives final approval (mirrors leave_requests).
      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'wfh') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return {
          error: 'Only HR or admin can approve WFH requests.',
          status: 403,
        };
      }

      await applyWfhApproval(client, {
        employeeId: Number(row.employee_id),
        requestId: id,
        reviewedBy: reviewerId,
      });

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'resignation') {
      if (!HR_RESIGNATION_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return { error: 'Only HR or admin can approve resignation requests.', status: 403 };
      }

      await applyResignationApproval(client, {
        employeeId: Number(row.employee_id),
        companyId: Number(row.company_id),
        requestId: id,
        reviewerId,
      });

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'loan' || row.request_type === 'advance') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return { error: 'Only HR or admin can approve loan or advance requests.', status: 403 };
      }

      await applyLoanApproval(client, {
        employeeId: Number(row.employee_id),
        companyId: Number(row.company_id),
        requestId: id,
      });

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'pf_temporary') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return {
          error: 'Only HR or admin can approve PF temporary requests.',
          status: 403,
        };
      }

      const pfTemporaryResult = await applyPfTemporaryApproval(client, {
        employeeId: Number(row.employee_id),
        companyId: Number(row.company_id),
        requestId: id,
        recordedBy: reviewerId,
      });
      if (pfTemporaryResult?.error) {
        await client.query('ROLLBACK');
        return { error: pfTemporaryResult.error, status: pfTemporaryResult.status || 400 };
      }

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'pf_permanent') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return {
          error: 'Only HR or admin can approve PF permanent requests.',
          status: 403,
        };
      }

      const pfPermanentResult = await applyPfPermanentApproval(client, {
        employeeId: Number(row.employee_id),
        companyId: Number(row.company_id),
        requestId: id,
        recordedBy: reviewerId,
      });
      if (pfPermanentResult?.error) {
        await client.query('ROLLBACK');
        return { error: pfPermanentResult.error, status: pfPermanentResult.status || 400 };
      }

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id]
      );
    } else if (row.request_type === 'expense') {
      if (!HR_FINAL_APPROVE_ROLES.has(reviewerRole)) {
        await client.query('ROLLBACK');
        return { error: 'Only HR or admin can approve expense claims.', status: 403 };
      }

      const paidInResolution = await resolvePaidInForExpenseRequest(client, id, body?.paid_in);
      if (paidInResolution.error) {
        await client.query('ROLLBACK');
        return { error: paidInResolution.error, status: 400 };
      }

      const approvalResult = await applyExpenseApproval(client, id, {
        paid_in: paidInResolution.paidIn,
        status_date: body?.status_date,
      });
      if (approvalResult?.error) {
        await client.query('ROLLBACK');
        return { error: approvalResult.error, status: 400 };
      }

      await client.query(
        `UPDATE requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = $2,
             updated_at = $2,
             hr_comment = COALESCE(NULLIF(TRIM($4), ''), hr_comment),
             review_stage = NULL
         WHERE id = $3`,
        [reviewerId, now, id, String(body?.hr_comment || '').trim()]
      );
    } else {
      await client.query('ROLLBACK');
      return { error: 'This request type cannot be approved yet.', status: 400 };
    }

    await client.query('COMMIT');

    const updated = await fetchMappedRequest(id);
    notifyRequestStatusEmails('approved', updated);
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rejectRequest(auth, requestId, hrComment) {
  const reviewerCtx = await getReviewerContext(auth);
  if (reviewerCtx.error) {
    return { error: reviewerCtx.error, status: 403 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const comment = String(hrComment || '').trim();
  if (!comment) {
    return { error: 'hr_comment is required.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const row = await getRequestForReview(client, id, reviewerCtx.user);
    if (!row) {
      await client.query('ROLLBACK');
      return { error: 'Request not found.', status: 404 };
    }
    if (row.status === 'rejected') {
      await client.query('ROLLBACK');
      return { error: 'Request is already rejected.', status: 409 };
    }
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { error: 'Cancelled requests cannot be updated.', status: 409 };
    }
    if (row.status !== 'pending' && row.status !== 'manager_approved' && row.status !== 'approved') {
      await client.query('ROLLBACK');
      return { error: `Request is already ${row.status}.`, status: 409 };
    }
    if (row.status === 'approved' && !ADMIN_EDITABLE_REQUEST_TYPES.has(row.request_type)) {
      await client.query('ROLLBACK');
      return { error: 'This request type cannot be updated yet.', status: 400 };
    }

    // Revert attendance / financial side effects when rejecting an approved request.
    if (row.status === 'approved') {
      await revertApprovedRequestEffects(client, row, id);
    }

    // manager_reviewed_by/manager_reviewed_at are left untouched so the manager-stage
    // audit trail survives an admin rejection (mirrors leave_requests' admin reject path).
    await client.query(
      `UPDATE requests
       SET status = 'rejected',
           hr_comment = $1,
           reviewed_by = $2,
           reviewed_at = $3,
           updated_at = $3,
           review_stage = NULL
       WHERE id = $4`,
      [comment, reviewerCtx.user.id, utcNowForPgTimestamp(), id]
    );

    await client.query('COMMIT');

    const updated = await fetchMappedRequest(id);
    notifyRequestStatusEmails('rejected', updated, comment);
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cancelRequest(auth, requestId) {
  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const id = parsePositiveInt(requestId);
  if (!id) {
    return { error: 'Invalid request id.', status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, employee_id, status, request_type, review_stage
       FROM requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'Request not found.', status: 404 };
    }

    const row = result.rows[0];
    if (Number(row.employee_id) !== employeeId) {
      await client.query('ROLLBACK');
      return { error: 'You can only cancel your own requests.', status: 403 };
    }
    if (row.status !== 'pending' && row.status !== 'manager_approved') {
      await client.query('ROLLBACK');
      return { error: `Request is already ${row.status}.`, status: 409 };
    }
    if (!canEmployeeCancelResignation(row)) {
      await client.query('ROLLBACK');
      return {
        error: 'This resignation request can no longer be cancelled.',
        status: 409,
      };
    }

    await client.query(
      `UPDATE requests
       SET status = 'cancelled', updated_at = $1
       WHERE id = $2`,
      [utcNowForPgTimestamp(), id]
    );

    await client.query('COMMIT');

    const updated = await fetchMappedRequest(id);
    return { data: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createRequest,
  listMyRequests,
  listAdminRequests,
  listPendingRequests,
  approveRequest,
  rejectRequest,
  cancelRequest,
  updateRequest,
  previewResignation,
  listTeamRequests,
  getTeamRequestById,
  updateTeamRequestStatus,
  listTeamAttendanceCorrectionRequests,
  getTeamAttendanceCorrectionRequestById,
  updateTeamAttendanceCorrectionStatus,
  HR_REQUEST_ROLES,
};
