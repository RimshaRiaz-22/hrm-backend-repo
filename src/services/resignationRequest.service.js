const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { toDateKey, parseOptionalDateInput } = require('../utils/dateTime');
const { getEmployeeIdFromAuth } = require('../utils/employeeAuth');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_NOTICE_PERIOD_DAYS = 30;

const HR_RESIGNATION_APPROVE_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
]);

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateOnly(value) {
  const parsed = parseOptionalDateInput(value, 'date');
  if (parsed.error || !parsed.value) return null;
  return parsed.value;
}

function addCalendarDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00.000Z`);
  const to = new Date(`${toDateStr}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function calculateLastWorkingDate({ lastIntendedDate, noticePeriodDays, referenceDate }) {
  if (!noticePeriodDays || noticePeriodDays <= 0) {
    return lastIntendedDate >= referenceDate ? lastIntendedDate : referenceDate;
  }
  const noticeEnd = addCalendarDays(referenceDate, noticePeriodDays);
  return lastIntendedDate > noticeEnd ? lastIntendedDate : noticeEnd;
}

async function getEmployeeProbationContext(client, employeeId, referenceDate = getTodayDateString()) {
  const result = await client.query(
    `SELECT probation_end_date, notice_period_days
     FROM employee_job_details
     WHERE employee_id = $1`,
    [employeeId]
  );
  const row = result.rows[0];
  if (!row) {
    return {
      onProbation: false,
      noticePeriodDays: DEFAULT_NOTICE_PERIOD_DAYS,
      probationEndDate: null,
    };
  }

  const probationEndDate = row.probation_end_date ? toDateKey(row.probation_end_date) : null;
  const onProbation = Boolean(probationEndDate && referenceDate <= probationEndDate);

  const contractNoticeDays = Number(row.notice_period_days);
  const noticePeriodDays = onProbation
    ? 0
    : Number.isInteger(contractNoticeDays) && contractNoticeDays > 0
      ? contractNoticeDays
      : DEFAULT_NOTICE_PERIOD_DAYS;

  return { onProbation, noticePeriodDays, probationEndDate };
}

async function getEmployeeNoticePeriodDays(client, employeeId, referenceDate) {
  const context = await getEmployeeProbationContext(client, employeeId, referenceDate);
  return context.noticePeriodDays;
}

async function previewResignation(auth, query = {}) {
  const employeeId = await getEmployeeIdFromAuth(auth);
  if (!employeeId) {
    return { error: 'No employee profile linked to this user.', status: 404 };
  }

  const lastIntendedDate = parseDateOnly(query.last_intended_date);
  if (!lastIntendedDate) {
    return { error: 'last_intended_date must be a valid date.', status: 400 };
  }

  const today = getTodayDateString();
  if (lastIntendedDate < today) {
    return { error: 'Last intended date cannot be in the past.', status: 400 };
  }

  const probationContext = await getEmployeeProbationContext(pool, employeeId, today);
  const calculatedLastWorkingDate = calculateLastWorkingDate({
    lastIntendedDate,
    noticePeriodDays: probationContext.noticePeriodDays,
    referenceDate: today,
  });

  return {
    data: {
      notice_period_days: probationContext.noticePeriodDays,
      on_probation: probationContext.onProbation,
      probation_end_date: probationContext.probationEndDate,
      last_intended_date: lastIntendedDate,
      calculated_last_working_date: calculatedLastWorkingDate,
      reference_date: today,
    },
  };
}

function validateResignationDetails(details) {
  if (!details || typeof details !== 'object') {
    return { error: 'details object is required.' };
  }

  const lastIntendedDate = parseDateOnly(details.last_intended_date);
  if (!lastIntendedDate) {
    return { error: 'details.last_intended_date must be a valid date.' };
  }

  const today = getTodayDateString();
  if (lastIntendedDate < today) {
    return { error: 'Last intended date cannot be in the past.' };
  }

  const reason = details.reason != null ? String(details.reason).trim() : '';
  if (!reason) {
    return { error: 'details.reason is required.' };
  }
  if (reason.length > 2000) {
    return { error: 'details.reason must be at most 2000 characters.' };
  }

  const attachmentUrl = details.attachment_url != null ? String(details.attachment_url).trim() : '';
  if (attachmentUrl.length > 2000) {
    return { error: 'details.attachment_url must be at most 2000 characters.' };
  }
  if (attachmentUrl && !attachmentUrl.includes('/uploads/')) {
    return { error: 'details.attachment_url must be a valid uploaded file URL.' };
  }

  const attachmentName =
    details.attachment_name != null ? String(details.attachment_name).trim().slice(0, 255) : '';
  const attachmentMimeType =
    details.attachment_mime_type != null
      ? String(details.attachment_mime_type).trim().slice(0, 100)
      : '';

  if (attachmentMimeType) {
    const isImage = attachmentMimeType.startsWith('image/');
    const isPdf = attachmentMimeType === 'application/pdf';
    if (!isImage && !isPdf) {
      return { error: 'details.attachment_mime_type must be an image or PDF.' };
    }
  }

  return {
    lastIntendedDate,
    reason,
    attachmentUrl: attachmentUrl || null,
    attachmentName: attachmentName || null,
    attachmentMimeType: attachmentMimeType || null,
  };
}

async function createResignationRequest(client, { employeeId, companyId, requestType, details }) {
  const detailsValidation = validateResignationDetails(details);
  if (detailsValidation.error) {
    return { error: detailsValidation.error, status: 400 };
  }

  const existingPending = await client.query(
    `SELECT r.id
     FROM requests r
     WHERE r.employee_id = $1
       AND r.request_type = 'resignation'
       AND r.status = 'pending'`,
    [employeeId]
  );
  if (existingPending.rowCount > 0) {
    return { error: 'You already have a pending resignation request.', status: 409 };
  }

  const servingNotice = await client.query(
    `SELECT id FROM notice_periods
     WHERE employee_id = $1 AND status = 'serving'
     LIMIT 1`,
    [employeeId]
  );
  if (servingNotice.rowCount > 0) {
    return { error: 'You are already serving a notice period.', status: 409 };
  }

  const today = getTodayDateString();
  const noticePeriodDays = await getEmployeeNoticePeriodDays(client, employeeId, today);
  const calculatedLastWorkingDate = calculateLastWorkingDate({
    lastIntendedDate: detailsValidation.lastIntendedDate,
    noticePeriodDays,
    referenceDate: today,
  });

  const requestResult = await client.query(
    `INSERT INTO requests (
       company_id, employee_id, request_type, status, submitted_at, review_stage
     )
     VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP, NULL)
     RETURNING id`,
    [companyId, employeeId, requestType]
  );
  const requestId = Number(requestResult.rows[0].id);

  await client.query(
    `INSERT INTO resignation_details (
       request_id,
       last_intended_date,
       reason,
       notice_period_days,
       calculated_last_working_date,
       attachment_url,
       attachment_name,
       attachment_mime_type
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      requestId,
      detailsValidation.lastIntendedDate,
      detailsValidation.reason,
      noticePeriodDays,
      calculatedLastWorkingDate,
      detailsValidation.attachmentUrl,
      detailsValidation.attachmentName,
      detailsValidation.attachmentMimeType,
    ]
  );

  return { requestId };
}

async function loadResignationDetailsMap(requestIds) {
  const map = new Map();
  if (!requestIds.length) return map;

  const result = await pool.query(
    `SELECT request_id,
            last_intended_date,
            reason,
            notice_period_days,
            calculated_last_working_date,
            attachment_url,
            attachment_name,
            attachment_mime_type
     FROM resignation_details
     WHERE request_id = ANY($1::bigint[])`,
    [requestIds]
  );

  for (const row of result.rows) {
    map.set(Number(row.request_id), {
      last_intended_date: toDateKey(row.last_intended_date),
      reason: row.reason || null,
      notice_period_days: Number(row.notice_period_days),
      calculated_last_working_date: toDateKey(row.calculated_last_working_date),
      attachment_url: row.attachment_url || null,
      attachment_name: row.attachment_name || null,
      attachment_mime_type: row.attachment_mime_type || null,
    });
  }

  return map;
}

async function applyResignationApproval(client, { employeeId, companyId, requestId, reviewerId }) {
  const detailResult = await client.query(
    `SELECT last_intended_date, notice_period_days
     FROM resignation_details
     WHERE request_id = $1`,
    [requestId]
  );
  if (!detailResult.rows[0]) {
    throw new Error('Resignation details not found for approved request.');
  }

  const lastIntendedDate = toDateKey(detailResult.rows[0].last_intended_date);
  const noticeStartDate = getTodayDateString();
  const noticePeriodDays = await getEmployeeNoticePeriodDays(client, employeeId, noticeStartDate);
  const noticeEndDate = calculateLastWorkingDate({
    lastIntendedDate,
    noticePeriodDays,
    referenceDate: noticeStartDate,
  });

  await client.query(
    `UPDATE resignation_details
     SET calculated_last_working_date = $1,
         notice_period_days = $2
     WHERE request_id = $3`,
    [noticeEndDate, noticePeriodDays, requestId]
  );

  await client.query(
    `INSERT INTO notice_periods (
       employee_id, request_id, notice_start_date, notice_end_date, status
     )
     VALUES ($1, $2, $3, $4, 'serving')`,
    [employeeId, requestId, noticeStartDate, noticeEndDate]
  );

  await client.query(
    `UPDATE employees
     SET employment_status = 'serving_notice',
         last_working_date = $1
     WHERE id = $2`,
    [noticeEndDate, employeeId]
  );

  return { noticeStartDate, noticeEndDate, companyId, employeeId, reviewerId };
}

async function revertResignationApproval(client, { employeeId, requestId }) {
  await client.query(
    `DELETE FROM notice_periods WHERE request_id = $1`,
    [requestId]
  );

  await client.query(
    `UPDATE employees
     SET employment_status = 'active',
         last_working_date = NULL,
         exit_date = NULL,
         final_settlement_pending = false
     WHERE id = $1`,
    [employeeId]
  );
}

function canEmployeeCancelResignation(row) {
  if (row.request_type !== 'resignation') return true;
  return row.status === 'pending';
}

function getResignationApprovalStageMessage() {
  return 'Pending HR approval.';
}

module.exports = {
  DATE_REGEX,
  DEFAULT_NOTICE_PERIOD_DAYS,
  HR_RESIGNATION_APPROVE_ROLES,
  getTodayDateString,
  addCalendarDays,
  daysBetween,
  calculateLastWorkingDate,
  getEmployeeProbationContext,
  getEmployeeNoticePeriodDays,
  previewResignation,
  validateResignationDetails,
  createResignationRequest,
  loadResignationDetailsMap,
  applyResignationApproval,
  revertResignationApproval,
  canEmployeeCancelResignation,
  getResignationApprovalStageMessage,
};
