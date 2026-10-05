const pool = require('../db');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const {
  toUtcIsoString,
  utcNowForPgTimestamp,
  toDateKey,
  inclusiveCalendarDays,
  parseRequiredDateInput,
  parseOptionalDateInput,
  computeBillableLeaveDays,
} = require('../utils/dateTime');
const { getAuthenticatedCompanyAdmin, parsePositiveInt } = require('./leavePolicy.service');
const { getAuthenticatedEmployee, deductBalanceForApprovedLeave } = require('./leaveBalance.service');
const { getCompanyHolidayDateKeysForRange } = require('./holiday.service');
const leaveEmailNotification = require('./leaveEmailNotification.service');
const leaveApprovalWorkflowService = require('./leaveApprovalWorkflow.service');

const REQUEST_STATUSES = new Set(['pending', 'manager_approved', 'approved', 'rejected', 'cancelled']);
const ADMIN_SETTABLE_STATUSES = new Set(['approved', 'rejected', 'cancelled']);
const LM_SETTABLE_STATUSES = new Set(['manager_approved', 'rejected']);
const ADMIN_ACTIONABLE_STATUSES = new Set(['pending', 'manager_approved']);
const EMPLOYEE_CANCELLABLE_STATUSES = new Set(['pending', 'manager_approved']);
const ACTIVE_OVERLAP_STATUSES = ['pending', 'manager_approved', 'approved'];

function parseDateOnly(raw, fieldName) {
  return parseRequiredDateInput(raw, fieldName);
}

function parseOptionalDateOnly(raw, fieldName) {
  return parseOptionalDateInput(raw, fieldName);
}

const SORT_FIELDS = new Map([
  ['created_at', 'lr.created_at'],
  ['from_date', 'lr.from_date'],
  ['status', 'lr.status'],
]);

const REQUEST_SELECT = `lr.id,
  lr.company_id,
  lr.employee_id,
  lr.leave_policy_id,
  lr.from_date,
  lr.to_date,
  lr.total_days,
  lr.reason,
  lr.status,
  lr.manager_comment,
  lr.hr_comment,
  lr.manager_reviewed_by,
  lr.manager_reviewed_at,
  lr.hr_reviewed_by,
  lr.hr_reviewed_at,
  lr.created_at,
  lr.updated_at,
  e.employee_code,
  e.first_name AS employee_first_name,
  e.last_name AS employee_last_name,
  e.work_email AS employee_email,
  lp.name AS leave_policy_name,
  lp.code AS leave_policy_code,
  lp.paid_status AS leave_policy_paid_status,
  mgr_e.first_name AS manager_reviewer_first_name,
  mgr_e.last_name AS manager_reviewer_last_name,
  mgr_e.work_email AS manager_reviewer_email,
  mgr_e.employee_code AS manager_reviewer_code,
  hr_u.full_name AS hr_reviewer_name,
  hr_u.email AS hr_reviewer_email`;

const REQUEST_FROM = `FROM leave_requests lr
  INNER JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id
  INNER JOIN leave_policies lp ON lp.id = lr.leave_policy_id AND lp.company_id = lr.company_id
  LEFT JOIN employees mgr_e ON mgr_e.id = lr.manager_reviewed_by AND mgr_e.company_id = lr.company_id
  LEFT JOIN users hr_u ON hr_u.id = lr.hr_reviewed_by`;

const REQUEST_FROM_WITH_JOB = `${REQUEST_FROM}
  INNER JOIN employee_job_details ejd
    ON ejd.employee_id = lr.employee_id AND ejd.company_id = lr.company_id`;

function parseSort(query = {}) {
  const sortByRaw = String(query.sort_by || query.sortBy || 'created_at').trim();
  const sortColumn = SORT_FIELDS.get(sortByRaw);
  if (!sortColumn) {
    return { error: `sort_by must be one of: ${Array.from(SORT_FIELDS.keys()).join(', ')}.` };
  }
  const orderRaw = String(query.sort_order || query.sortOrder || 'desc').trim().toLowerCase();
  if (!['asc', 'desc'].includes(orderRaw)) {
    return { error: 'sort_order must be asc or desc.' };
  }
  return {
    orderBySql: `${sortColumn} ${orderRaw.toUpperCase()}, lr.id DESC`,
    sort_by: sortByRaw,
    sort_order: orderRaw,
  };
}

function computeTotalDays(fromDate, toDate) {
  return inclusiveCalendarDays(fromDate, toDate);
}

function mapLeavePolicySummary(row) {
  return {
    id: Number(row.leave_policy_id),
    name: row.leave_policy_name,
    code: row.leave_policy_code,
    paid_status: row.leave_policy_paid_status,
  };
}

function mapEmployeeSummary(row) {
  return {
    id: Number(row.employee_id),
    employee_code: row.employee_code ?? null,
    first_name: row.employee_first_name,
    last_name: row.employee_last_name,
    email: row.employee_email ?? null,
  };
}

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
  if (row.hr_reviewed_by == null) return null;
  return {
    id: Number(row.hr_reviewed_by),
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

function mapLeaveRequestRow(row, { includeEmployee = false } = {}) {
  const managerReviewedBy = mapManagerReviewerSummary(row);
  const hrReviewedBy = mapHrReviewerSummary(row);
  const item = {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    leave_policy_id: Number(row.leave_policy_id),
    leave_policy: mapLeavePolicySummary(row),
    from_date: toDateKey(row.from_date),
    to_date: toDateKey(row.to_date),
    // Always expose inclusive calendar duration so admin/email match employee create UX
    // (approval must not replace this with holiday-excluded billable days).
    total_days:
      inclusiveCalendarDays(toDateKey(row.from_date), toDateKey(row.to_date)) ??
      Number(row.total_days),
    reason: row.reason,
    status: row.status,
    manager_comment: row.manager_comment ?? null,
    hr_comment: row.hr_comment ?? null,
    manager_reviewed_by: managerReviewedBy,
    manager_reviewed_at: row.manager_reviewed_at ? toUtcIsoString(row.manager_reviewed_at) : null,
    hr_reviewed_by: hrReviewedBy,
    hr_reviewed_at: row.hr_reviewed_at ? toUtcIsoString(row.hr_reviewed_at) : null,
    approved_by: resolveApprovedBySummary(row.status, managerReviewedBy, hrReviewedBy),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
  if (includeEmployee) {
    item.employee = mapEmployeeSummary(row);
  }
  return item;
}

async function fetchLeaveRequestById(requestId, companyId) {
  const result = await pool.query(
    `SELECT ${REQUEST_SELECT}
     ${REQUEST_FROM}
     WHERE lr.id = $1 AND lr.company_id = $2`,
    [requestId, companyId]
  );
  return result.rows[0] || null;
}

async function fetchLeavePolicy(leavePolicyId, companyId) {
  const result = await pool.query(
    `SELECT id, status FROM leave_policies WHERE id = $1 AND company_id = $2`,
    [leavePolicyId, companyId]
  );
  return result.rows[0] || null;
}

/** Attaches { total_steps, current_step_order, current_step_description } (or null) per item. */
async function enrichWithApprovalProgress(items) {
  await Promise.all(
    items.map(async (item) => {
      item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
    })
  );
  return items;
}

/** Same as enrichWithApprovalProgress, plus is_actionable_by_me for the team/manager views. */
async function enrichTeamItemsWithActionability(items, companyId, actingUserId) {
  await Promise.all(
    items.map(async (item) => {
      item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
      item.is_actionable_by_me = item.approval_progress
        ? await leaveApprovalWorkflowService.isUserActionableOnRequest(
            pool,
            companyId,
            actingUserId,
            item.id,
            item.employee_id
          )
        : item.status === 'pending';
    })
  );
  return items;
}

/** POST /api/v1/leaves/requests — employee requests leave for themselves. */
async function createLeaveRequest(authUser, body) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const leavePolicyId = parsePositiveInt(body?.leave_policy_id);
  if (!leavePolicyId) return { error: [400, 'leave_policy_id must be a positive integer.'] };

  const fromResult = parseDateOnly(body?.from_date, 'from_date');
  if (fromResult.error) return { error: [400, fromResult.error] };

  const toRawProvided =
    body?.to_date !== undefined && body?.to_date !== null && String(body.to_date).trim() !== '';
  const toResult = parseDateOnly(toRawProvided ? body.to_date : body?.from_date, 'to_date');
  if (toResult.error) return { error: [400, toResult.error] };

  if (toResult.value < fromResult.value) {
    return { error: [400, 'to_date cannot be before from_date.'] };
  }

  const reason = String(body?.reason || '').trim();
  if (!reason) return { error: [400, 'reason is required.'] };
  if (reason.length > 1000) return { error: [400, 'reason must be at most 1000 characters.'] };

  const policy = await fetchLeavePolicy(leavePolicyId, auth.companyId);
  if (!policy) return { error: [404, 'Leave policy not found.'] };
  if (policy.status !== 'active') return { error: [400, 'This leave policy is not active.'] };

  const totalDays = computeTotalDays(fromResult.value, toResult.value);

  const overlap = await pool.query(
    `SELECT id FROM leave_requests
     WHERE employee_id = $1
       AND company_id = $2
       AND status = ANY($5::text[])
       AND from_date <= $4::date
       AND to_date >= $3::date
     LIMIT 1`,
    [auth.employeeId, auth.companyId, fromResult.value, toResult.value, ACTIVE_OVERLAP_STATUSES]
  );
  if (overlap.rowCount > 0) {
    return { error: [409, 'You already have a pending or approved leave request overlapping these dates.'] };
  }

  const nowUtc = utcNowForPgTimestamp();
  const client = await pool.connect();
  let newRequestId = null;
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO leave_requests (
         company_id, employee_id, leave_policy_id, from_date, to_date,
         total_days, reason, status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'pending', $8::timestamp, $8::timestamp)
       RETURNING id`,
      [
        auth.companyId,
        auth.employeeId,
        leavePolicyId,
        fromResult.value,
        toResult.value,
        totalDays,
        reason,
        nowUtc,
      ]
    );
    newRequestId = insert.rows[0].id;
    await leaveApprovalWorkflowService.snapshotApprovalStepsForRequest(
      client,
      newRequestId,
      leavePolicyId,
      auth.companyId
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const row = await fetchLeaveRequestById(newRequestId, auth.companyId);

  leaveEmailNotification.notifyLeaveRequestSubmitted(auth.companyId, row).catch((error) => {
    console.error('Leave request submitted email error:', error);
  });
  leaveEmailNotification.notifyLeaveRequestReceived(auth.companyId, row).catch((error) => {
    console.error('Leave request received email error:', error);
  });
  leaveEmailNotification.notifyLineManagerLeaveRequestSubmitted(auth.companyId, row).catch((error) => {
    console.error('Leave request line manager email error:', error);
  });

  const item = mapLeaveRequestRow(row);
  item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
  return { leave_request: item };
}

/** GET /api/v1/leaves/requests/me — employee's own leave requests. */
function buildMyLeaveRequestFilters(query, companyId, employeeId) {
  const values = [companyId, employeeId];
  const filters = ['lr.company_id = $1', 'lr.employee_id = $2'];
  let idx = 3;

  const statusFilter = query?.status !== undefined ? String(query.status).trim().toLowerCase() : '';
  if (statusFilter && !REQUEST_STATUSES.has(statusFilter)) {
    return { error: `status must be one of: ${Array.from(REQUEST_STATUSES).join(', ')}.` };
  }
  if (statusFilter) {
    filters.push(`lr.status = $${idx++}`);
    values.push(statusFilter);
  }

  const fromResult = parseOptionalDateOnly(query?.from_date ?? query?.from, 'from_date');
  if (fromResult.error) return { error: fromResult.error };

  const toResult = parseOptionalDateOnly(query?.to_date ?? query?.to, 'to_date');
  if (toResult.error) return { error: toResult.error };

  if (fromResult.value && toResult.value && toResult.value < fromResult.value) {
    return { error: 'to_date cannot be before from_date.' };
  }

  // Overlap filter: include requests whose leave period touches the requested range.
  if (fromResult.value) {
    filters.push(`lr.to_date >= $${idx++}::date`);
    values.push(fromResult.value);
  }
  if (toResult.value) {
    filters.push(`lr.from_date <= $${idx++}::date`);
    values.push(toResult.value);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(
      lp.name ILIKE $${idx}
      OR lp.code ILIKE $${idx}
      OR lr.reason ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return {
    whereSql: filters.join(' AND '),
    nextIdx: idx,
    values,
    status: statusFilter || null,
    from_date: fromResult.value,
    to_date: toResult.value,
    search: search || null,
  };
}

async function getMyLeaveRequests(authUser, query) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query);
  if (sort.error) return { error: [400, sort.error] };

  const filterResult = buildMyLeaveRequestFilters(query, auth.companyId, auth.employeeId);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const { whereSql, values, nextIdx } = filterResult;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${REQUEST_FROM} WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE ${whereSql} ORDER BY ${sort.orderBySql}`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    leave_requests: await enrichWithApprovalProgress(result.rows.map((row) => mapLeaveRequestRow(row))),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      status: filterResult.status,
      from_date: filterResult.from_date,
      to_date: filterResult.to_date,
      search: filterResult.search,
    },
  };
}

/** GET /api/v1/leaves/requests/me/:id — employee's own leave request detail. */
async function getMyLeaveRequestById(authUser, requestId) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const row = await fetchLeaveRequestById(requestId, auth.companyId);
  if (!row || Number(row.employee_id) !== auth.employeeId) {
    return { error: [404, 'Leave request not found.'] };
  }
  const item = mapLeaveRequestRow(row);
  item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
  return { leave_request: item };
}

function buildAdminListFilters(query, values, startIdx) {
  const filters = [`lr.company_id = $1`];
  let idx = startIdx;
  const statusFilter = query?.status !== undefined ? String(query.status).trim().toLowerCase() : '';
  if (statusFilter && !REQUEST_STATUSES.has(statusFilter)) {
    return { error: `status must be one of: ${Array.from(REQUEST_STATUSES).join(', ')}.` };
  }
  if (statusFilter) {
    filters.push(`lr.status = $${idx++}`);
    values.push(statusFilter);
  }

  const employeeId = parsePositiveInt(query?.employee_id);
  if (query?.employee_id !== undefined && !employeeId) {
    return { error: 'employee_id must be a positive integer.' };
  }
  if (employeeId) {
    filters.push(`lr.employee_id = $${idx++}`);
    values.push(employeeId);
  }

  const leavePolicyId = parsePositiveInt(query?.leave_policy_id);
  if (query?.leave_policy_id !== undefined && !leavePolicyId) {
    return { error: 'leave_policy_id must be a positive integer.' };
  }
  if (leavePolicyId) {
    filters.push(`lr.leave_policy_id = $${idx++}`);
    values.push(leavePolicyId);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(
      e.first_name ILIKE $${idx}
      OR e.last_name ILIKE $${idx}
      OR COALESCE(e.employee_code, '') ILIKE $${idx}
      OR lp.name ILIKE $${idx}
      OR lp.code ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return {
    whereSql: filters.join(' AND '),
    nextIdx: idx,
    status: statusFilter,
    employee_id: employeeId,
    leave_policy_id: leavePolicyId,
    search,
  };
}

/** GET /api/v1/leaves/requests — company admin lists requests across the company. */
async function getLeaveRequests(companyId, query) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query);
  if (sort.error) return { error: [400, sort.error] };

  const values = [companyId];
  const filterResult = buildAdminListFilters(query, values, 2);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const whereSql = filterResult.whereSql;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${REQUEST_FROM} WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM} WHERE ${whereSql} ORDER BY ${sort.orderBySql}`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${filterResult.nextIdx} OFFSET $${filterResult.nextIdx + 1}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    leave_requests: await enrichWithApprovalProgress(
      result.rows.map((row) => mapLeaveRequestRow(row, { includeEmployee: true }))
    ),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      status: filterResult.status || null,
      employee_id: filterResult.employee_id || null,
      leave_policy_id: filterResult.leave_policy_id || null,
      search: filterResult.search || null,
    },
  };
}

/** GET /api/v1/leaves/requests/:id — company admin views a single request. */
async function getLeaveRequestById(requestId, companyId) {
  const row = await fetchLeaveRequestById(requestId, companyId);
  if (!row) return { error: [404, 'Leave request not found.'] };
  const item = mapLeaveRequestRow(row, { includeEmployee: true });
  item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
  return { leave_request: item };
}


async function updateLeaveRequestStatus(requestId, companyId, body, reviewerUserId = null) {
  const newStatus = String(body?.status || '').trim().toLowerCase();
  if (!ADMIN_SETTABLE_STATUSES.has(newStatus)) {
    return { error: [400, `status must be one of: ${Array.from(ADMIN_SETTABLE_STATUSES).join(', ')}.`] };
  }

  const hrComment =
    body?.hr_comment !== undefined && body?.hr_comment !== null ? String(body.hr_comment).trim() : null;
  if (hrComment !== null && hrComment.length > 1000) {
    return { error: [400, 'hr_comment must be at most 1000 characters.'] };
  }

  const nowUtc = utcNowForPgTimestamp();
  const client = await pool.connect();
  let resultError = null;
  let balanceBeforeApproval = null;
  let approvedFromDateKey = null;

  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT id, employee_id, leave_policy_id,
              from_date::text AS from_date_key,
              to_date::text AS to_date_key,
              total_days, status
       FROM leave_requests
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [requestId, companyId]
    );
    if (existingResult.rowCount === 0) {
      resultError = [404, 'Leave request not found.'];
    } else {
      const existing = existingResult.rows[0];

      // If this request has a configured multi-step workflow, a Company Admin action here is an
      // override: any steps still pending are marked 'skipped' before applying the decision below.
      // No-op (0 rows) for requests without a workflow, so this never changes existing behavior.
      await leaveApprovalWorkflowService.skipPendingStepsForRequest(client, requestId, reviewerUserId, nowUtc);

      if (!ADMIN_ACTIONABLE_STATUSES.has(existing.status)) {
        resultError = [
          400,
          `Only pending or manager-approved leave requests can be updated. This request is already ${existing.status}.`,
        ];
      } else if (newStatus === 'approved') {
        const fromDateKey = existing.from_date_key;
        const toDateKeyValue = existing.to_date_key;
        const year = Number(fromDateKey.slice(0, 4));
        const holidayDateKeys = await getCompanyHolidayDateKeysForRange(
          companyId,
          fromDateKey,
          toDateKeyValue,
          client
        );
        const billableDays = computeBillableLeaveDays(
          fromDateKey,
          toDateKeyValue,
          holidayDateKeys
        );

        const deduction = await deductBalanceForApprovedLeave(
          client,
          existing.employee_id,
          existing.leave_policy_id,
          year,
          billableDays,
          nowUtc,
          fromDateKey
        );
        if (deduction.error) {
          resultError = [400, deduction.error];
        } else {
          balanceBeforeApproval = deduction.balanceBeforeApproval;
          approvedFromDateKey = fromDateKey;
        }

        // Keep leave_requests.total_days as the calendar duration set at create
        // (inclusive from→to). Billable days are only used for balance deduction.
      }
    }

    if (resultError) {
      await client.query('ROLLBACK');
    } else {
      await client.query(
        `UPDATE leave_requests
         SET status = $1,
             hr_comment = $2,
             hr_reviewed_by = $3,
             hr_reviewed_at = $4::timestamp,
             updated_at = $4::timestamp
         WHERE id = $5 AND company_id = $6`,
        [newStatus, hrComment, reviewerUserId, nowUtc, requestId, companyId]
      );
      await client.query('COMMIT');
    }
  } catch (error) {
    try {
      
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }

  if (resultError) return { error: resultError };

  const row = await fetchLeaveRequestById(requestId, companyId);

  if (newStatus === 'approved') {
    leaveEmailNotification.notifyLeaveApproved(companyId, row).catch((error) => {
      console.error('Leave approved email error:', error);
    });
    if (balanceBeforeApproval) {
      const balanceRow = await fetchLeaveBalanceRowForRequest(
        companyId,
        row.employee_id,
        row.leave_policy_id,
        approvedFromDateKey || toDateKey(row.from_date)
      );
      if (balanceRow) {
        leaveEmailNotification
          .notifyLeaveBalanceUpdated(companyId, balanceRow, {
            previousAvailable: balanceBeforeApproval.available_days,
            previousUsed: balanceBeforeApproval.used_days,
            previousTotal: balanceBeforeApproval.total_days,
          })
          .catch((error) => {
            console.error('Leave balance updated email error:', error);
          });
      }
    }
  } else if (newStatus === 'rejected') {
    leaveEmailNotification.notifyLeaveRejected(companyId, row, hrComment).catch((error) => {
      console.error('Leave rejected email error:', error);
    });
  } else if (newStatus === 'cancelled') {
    leaveEmailNotification.notifyLeaveCancelled(companyId, row).catch((error) => {
      console.error('Leave cancelled email error:', error);
    });
  }

  const item = mapLeaveRequestRow(row, { includeEmployee: true });
  item.approval_progress = await leaveApprovalWorkflowService.getApprovalProgress(pool, item.id);
  return { leave_request: item };
}

/** PATCH /api/v1/leaves/requests/me/:id/cancel — employee cancels their own open request. */
async function cancelMyLeaveRequest(authUser, requestId) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const nowUtc = utcNowForPgTimestamp();
  const update = await pool.query(
    `UPDATE leave_requests
     SET status = 'cancelled', updated_at = $1::timestamp
     WHERE id = $2
       AND company_id = $3
       AND employee_id = $4
       AND status = ANY($5::text[])
     RETURNING id`,
    [nowUtc, requestId, auth.companyId, auth.employeeId, Array.from(EMPLOYEE_CANCELLABLE_STATUSES)]
  );

  if (update.rowCount === 0) {
    const existing = await pool.query(
      `SELECT id, status FROM leave_requests
       WHERE id = $1 AND company_id = $2 AND employee_id = $3`,
      [requestId, auth.companyId, auth.employeeId]
    );
    if (existing.rowCount === 0) {
      return { error: [404, 'Leave request not found.'] };
    }
    return {
      error: [
        400,
        `Only pending or manager-approved leave requests can be cancelled. This request is already ${existing.rows[0].status}.`,
      ],
    };
  }

  const row = await fetchLeaveRequestById(requestId, auth.companyId);
  leaveEmailNotification.notifyLeaveCancelled(auth.companyId, row).catch((error) => {
    console.error('Leave cancelled email error:', error);
  });

  return { leave_request: mapLeaveRequestRow(row) };
}

async function fetchLeaveBalanceRowForRequest(companyId, employeeId, leavePolicyId, fromDateKey) {
  const year = Number(String(fromDateKey).slice(0, 4));
  const result = await pool.query(
    `SELECT lb.id, lb.company_id, lb.employee_id, lb.leave_policy_id, lb.year,
            lb.total_days, lb.used_days, lb.available_days,
            e.first_name AS employee_first_name,
            e.last_name AS employee_last_name,
            e.work_email AS employee_email,
            lp.name AS leave_policy_name
     FROM leave_balances lb
     INNER JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id
     INNER JOIN leave_policies lp ON lp.id = lb.leave_policy_id AND lp.company_id = lb.company_id
     WHERE lb.company_id = $1
       AND lb.employee_id = $2
       AND lb.leave_policy_id = $3
       AND lb.year = $4`,
    [companyId, employeeId, leavePolicyId, year]
  );
  return result.rows[0] || null;
}

/**
 * SQL EXISTS fragment: true when $paramIndex (a users.id) is the resolved approver of the
 * CURRENT pending step of a configured workflow (lr must be in scope as the leave_requests alias).
 * Structurally false for requests with no leave_request_approvals rows, so it's a pure addition
 * on top of the legacy employee_line_managers check — no change for policies without a workflow.
 */
function workflowActionableExistsSql(paramIndex) {
  return `EXISTS (
    SELECT 1
    FROM leave_request_approvals lra
    WHERE lra.leave_request_id = lr.id
      AND lra.status = 'pending'
      AND lra.step_order = (
        SELECT MIN(step_order) FROM leave_request_approvals WHERE leave_request_id = lr.id AND status = 'pending'
      )
      AND (
        (lra.approver_type = 'user' AND lra.approver_user_id = $${paramIndex})
        OR (lra.approver_type = 'access_role' AND EXISTS (
              SELECT 1 FROM users au
              WHERE au.id = $${paramIndex} AND au.access_role_id = lra.access_role_id AND au.is_active = true
            ))
        OR (lra.approver_type IN ('primary_manager', 'additional_manager') AND EXISTS (
              SELECT 1 FROM employee_line_managers elm2
              INNER JOIN users mu ON mu.employee_id = elm2.manager_id AND mu.company_id = elm2.company_id
              WHERE elm2.employee_id = lr.employee_id
                AND elm2.manager_role = (CASE lra.approver_type WHEN 'primary_manager' THEN 'primary' ELSE 'additional' END)
                AND mu.id = $${paramIndex}
            ))
        OR (lra.approver_type = 'department_head' AND EXISTS (
              SELECT 1 FROM employee_job_details ejd2
              INNER JOIN department_line_managers dlm2
                ON dlm2.department_id = ejd2.department_id AND dlm2.company_id = ejd2.company_id AND dlm2.manager_role = 'head'
              INNER JOIN users hu ON hu.employee_id = dlm2.employee_id AND hu.company_id = dlm2.company_id
              WHERE ejd2.employee_id = lr.employee_id AND hu.id = $${paramIndex}
            ))
      )
  )`;
}

/** True when $paramIndex (a users.id) has already acted on any step of this request — keeps it
 *  visible in their team list after they approve/reject, even once the chain has moved on. */
function actorHasActedExistsSql(paramIndex) {
  return `EXISTS (
    SELECT 1 FROM leave_request_approvals lra3
    WHERE lra3.leave_request_id = lr.id AND lra3.acted_by = $${paramIndex}
  )`;
}

/** True when $paramIndex (a users.id) is an approver at ANY step of the workflow —
 *  makes the request visible to all approvers from submission, not just the current step. */
function workflowAnyStepApproverExistsSql(paramIndex) {
  return `EXISTS (
    SELECT 1
    FROM leave_request_approvals lra4
    WHERE lra4.leave_request_id = lr.id
      AND (
        (lra4.approver_type = 'user' AND lra4.approver_user_id = $${paramIndex})
        OR (lra4.approver_type = 'access_role' AND EXISTS (
              SELECT 1 FROM users au4
              WHERE au4.id = $${paramIndex} AND au4.access_role_id = lra4.access_role_id AND au4.is_active = true
            ))
        OR (lra4.approver_type IN ('primary_manager', 'additional_manager') AND EXISTS (
              SELECT 1 FROM employee_line_managers elm4
              INNER JOIN users mu4 ON mu4.employee_id = elm4.manager_id AND mu4.company_id = elm4.company_id
              WHERE elm4.employee_id = lr.employee_id
                AND elm4.manager_role = (CASE lra4.approver_type WHEN 'primary_manager' THEN 'primary' ELSE 'additional' END)
                AND mu4.id = $${paramIndex}
            ))
        OR (lra4.approver_type = 'department_head' AND EXISTS (
              SELECT 1 FROM employee_job_details ejd4
              INNER JOIN department_line_managers dlm4
                ON dlm4.department_id = ejd4.department_id AND dlm4.company_id = ejd4.company_id AND dlm4.manager_role = 'head'
              INNER JOIN users hu4 ON hu4.employee_id = dlm4.employee_id AND hu4.company_id = dlm4.company_id
              WHERE ejd4.employee_id = lr.employee_id AND hu4.id = $${paramIndex}
            ))
      )
  )`;
}

function buildTeamListFilters(query, companyId, managerEmployeeId, managerUserId) {
  const values = [companyId, managerEmployeeId, managerUserId];
  const filters = [
    'lr.company_id = $1',
    `(
      (
        NOT EXISTS (SELECT 1 FROM leave_request_approvals lra0 WHERE lra0.leave_request_id = lr.id)
        AND EXISTS (
          SELECT 1
          FROM employee_line_managers elm
          WHERE elm.company_id = lr.company_id
            AND elm.employee_id = lr.employee_id
            AND elm.manager_id = $2
        )
      )
      OR ${workflowActionableExistsSql(3)}
      OR ${workflowAnyStepApproverExistsSql(3)}
      OR ${actorHasActedExistsSql(3)}
    )`,
  ];
  let idx = 4;

  const statusFilter = query?.status !== undefined ? String(query.status).trim().toLowerCase() : '';
  if (statusFilter && !REQUEST_STATUSES.has(statusFilter)) {
    return { error: `status must be one of: ${Array.from(REQUEST_STATUSES).join(', ')}.` };
  }
  if (statusFilter) {
    filters.push(`lr.status = $${idx++}`);
    values.push(statusFilter);
  }

  const leavePolicyId = parsePositiveInt(query?.leave_policy_id);
  if (query?.leave_policy_id !== undefined && !leavePolicyId) {
    return { error: 'leave_policy_id must be a positive integer.' };
  }
  if (leavePolicyId) {
    filters.push(`lr.leave_policy_id = $${idx++}`);
    values.push(leavePolicyId);
  }

  const search = query?.search !== undefined ? String(query.search).trim() : '';
  if (search) {
    filters.push(`(
      e.first_name ILIKE $${idx}
      OR e.last_name ILIKE $${idx}
      OR COALESCE(e.employee_code, '') ILIKE $${idx}
      OR lp.name ILIKE $${idx}
      OR lp.code ILIKE $${idx}
      OR lr.reason ILIKE $${idx}
    )`);
    values.push(`%${search}%`);
    idx += 1;
  }

  return {
    whereSql: filters.join(' AND '),
    nextIdx: idx,
    values,
    status: statusFilter || null,
    leave_policy_id: leavePolicyId || null,
    search: search || null,
  };
}

async function assertTeamLeaveRequestAccess(companyId, requestId, managerEmployeeId, managerUserId) {
  const result = await pool.query(
    `SELECT lr.id
     FROM leave_requests lr
     WHERE lr.id = $1
       AND lr.company_id = $2
       AND (
         (
           NOT EXISTS (SELECT 1 FROM leave_request_approvals lra0 WHERE lra0.leave_request_id = lr.id)
           AND EXISTS (
             SELECT 1 FROM employee_line_managers elm
             WHERE elm.employee_id = lr.employee_id AND elm.company_id = lr.company_id AND elm.manager_id = $3
           )
         )
         OR ${workflowActionableExistsSql(4)}
         OR ${workflowAnyStepApproverExistsSql(4)}
         OR ${actorHasActedExistsSql(4)}
       )`,
    [requestId, companyId, managerEmployeeId, managerUserId]
  );
  return result.rowCount > 0;
}

/** GET /api/v1/leaves/requests/team — line manager lists direct reports' leave requests. */
async function getTeamLeaveRequests(authUser, query) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const sort = parseSort(query);
  if (sort.error) return { error: [400, sort.error] };

  const filterResult = buildTeamListFilters(query, auth.companyId, auth.employeeId, auth.user.id);
  if (filterResult.error) return { error: [400, filterResult.error] };

  const { whereSql, values, nextIdx } = filterResult;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${REQUEST_FROM_WITH_JOB} WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUEST_SELECT} ${REQUEST_FROM_WITH_JOB} WHERE ${whereSql} ORDER BY ${sort.orderBySql}`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    leave_requests: await enrichTeamItemsWithActionability(
      result.rows.map((row) => mapLeaveRequestRow(row, { includeEmployee: true })),
      auth.companyId,
      auth.user.id
    ),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
    sort: { sort_by: sort.sort_by, sort_order: sort.sort_order },
    filters: {
      status: filterResult.status,
      leave_policy_id: filterResult.leave_policy_id,
      search: filterResult.search,
    },
  };
}

/** GET /api/v1/leaves/requests/team/:id — line manager views a direct report's leave request. */
async function getTeamLeaveRequestById(authUser, requestId) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const hasAccess = await assertTeamLeaveRequestAccess(auth.companyId, requestId, auth.employeeId, auth.user.id);
  if (!hasAccess) return { error: [404, 'Leave request not found.'] };

  const row = await fetchLeaveRequestById(requestId, auth.companyId);
  const [item] = await enrichTeamItemsWithActionability(
    [mapLeaveRequestRow(row, { includeEmployee: true })],
    auth.companyId,
    auth.user.id
  );
  return { leave_request: item };
}

/** PATCH /api/v1/leaves/requests/team/:id/status — line manager approves or rejects a pending request. */
async function updateTeamLeaveRequestStatus(authUser, requestId, body) {
  const auth = await getAuthenticatedEmployee(authUser);
  if (auth.error) return { error: auth.error };

  const newStatus = String(body?.status || '').trim().toLowerCase();
  if (!LM_SETTABLE_STATUSES.has(newStatus)) {
    return {
      error: [400, `status must be one of: ${Array.from(LM_SETTABLE_STATUSES).join(', ')}.`],
    };
  }

  const managerComment =
    body?.manager_comment !== undefined && body?.manager_comment !== null
      ? String(body.manager_comment).trim()
      : null;
  if (managerComment !== null && managerComment.length > 1000) {
    return { error: [400, 'manager_comment must be at most 1000 characters.'] };
  }

  const hasAccess = await assertTeamLeaveRequestAccess(auth.companyId, requestId, auth.employeeId, auth.user.id);
  if (!hasAccess) return { error: [404, 'Leave request not found.'] };

  const nowUtc = utcNowForPgTimestamp();
  const client = await pool.connect();
  let resultError = null;
  // undefined = legacy single-tier path handled the write directly (newStatus is authoritative).
  // 'approved' | 'rejected' | null = workflow engine handled it (null = more steps remain, stays 'pending').
  let workflowFinalStatus;
  let balanceBeforeApproval = null;
  let approvedFromDateKey = null;

  try {
    await client.query('BEGIN');

    const currentStep = await leaveApprovalWorkflowService.getCurrentPendingStep(client, requestId);

    if (currentStep) {
      const requestRow = await client.query(
        `SELECT id, status, employee_id, leave_policy_id
         FROM leave_requests
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [requestId, auth.companyId]
      );

      if (requestRow.rowCount === 0) {
        resultError = [404, 'Leave request not found.'];
      } else if (!['pending', 'manager_approved'].includes(requestRow.rows[0].status)) {
        // 'manager_approved' covers step 2+ of a multi-step workflow (see below — status is set
        // to 'manager_approved', not left at 'pending', once the first step clears) — the
        // authoritative "is this step actionable" signal is leave_request_approvals, not this
        // coarse status; this guard only blocks acting on an already-terminal request.
        resultError = [
          400,
          `Only pending or manager-approved leave requests can be updated. This request is already ${requestRow.rows[0].status}.`,
        ];
      } else {
        const stepResult = await leaveApprovalWorkflowService.actOnRequestStep(
          client,
          auth.companyId,
          auth.user.id,
          requestId,
          Number(requestRow.rows[0].employee_id),
          newStatus === 'rejected' ? 'rejected' : 'approved',
          managerComment,
          nowUtc
        );

        if (stepResult.error) {
          resultError = stepResult.error;
        } else {
          workflowFinalStatus = stepResult.finalStatus;

          if (workflowFinalStatus === 'rejected') {
            await client.query(
              `UPDATE leave_requests
               SET status = 'rejected', manager_comment = $1, manager_reviewed_by = $2,
                   manager_reviewed_at = $3::timestamp, updated_at = $3::timestamp
               WHERE id = $4 AND company_id = $5`,
              [managerComment, auth.employeeId, nowUtc, requestId, auth.companyId]
            );
          } else if (workflowFinalStatus === 'approved') {
            const dateResult = await client.query(
              `SELECT from_date::text AS from_date_key, to_date::text AS to_date_key FROM leave_requests WHERE id = $1`,
              [requestId]
            );
            const fromDateKey = dateResult.rows[0].from_date_key;
            const toDateKeyValue = dateResult.rows[0].to_date_key;
            const year = Number(fromDateKey.slice(0, 4));
            const holidayDateKeys = await getCompanyHolidayDateKeysForRange(
              auth.companyId,
              fromDateKey,
              toDateKeyValue,
              client
            );
            const billableDays = computeBillableLeaveDays(fromDateKey, toDateKeyValue, holidayDateKeys);
            const deduction = await deductBalanceForApprovedLeave(
              client,
              Number(requestRow.rows[0].employee_id),
              Number(requestRow.rows[0].leave_policy_id),
              year,
              billableDays,
              nowUtc,
              fromDateKey
            );

            if (deduction.error) {
              resultError = [400, deduction.error];
            } else {
              balanceBeforeApproval = deduction.balanceBeforeApproval;
              approvedFromDateKey = fromDateKey;
              await client.query(
                `UPDATE leave_requests
                 SET status = 'approved', manager_comment = $1, manager_reviewed_by = $2,
                     manager_reviewed_at = $3::timestamp, updated_at = $3::timestamp
                 WHERE id = $4 AND company_id = $5`,
                [managerComment, auth.employeeId, nowUtc, requestId, auth.companyId]
              );
            }
          } else {
            // More steps remain: reuse 'manager_approved' as "at least one step cleared, not
            // fully resolved yet" so the requester, admin, and every existing status badge see
            // meaningful progress instead of a coarse 'pending' the whole way through. The next
            // step's actual actionability is still driven by leave_request_approvals, not this.
            await client.query(
              `UPDATE leave_requests
               SET status = 'manager_approved', manager_comment = $1, manager_reviewed_by = $2,
                   manager_reviewed_at = $3::timestamp, updated_at = $3::timestamp
               WHERE id = $4 AND company_id = $5`,
              [managerComment, auth.employeeId, nowUtc, requestId, auth.companyId]
            );
          }
        }
      }
    } else {
      // No configured workflow for this request: unchanged legacy single-tier behavior.
      const existingResult = await client.query(
        `SELECT lr.id, lr.status, lr.employee_id
         FROM leave_requests lr
         INNER JOIN employee_line_managers elm
           ON elm.employee_id = lr.employee_id
          AND elm.company_id = lr.company_id
          AND elm.manager_id = $3
         WHERE lr.id = $1
           AND lr.company_id = $2
         FOR UPDATE OF lr`,
        [requestId, auth.companyId, auth.employeeId]
      );

      if (existingResult.rowCount === 0) {
        resultError = [404, 'Leave request not found.'];
      } else if (existingResult.rows[0].status !== 'pending') {
        resultError = [
          400,
          `Only pending leave requests can be updated by a line manager. This request is already ${existingResult.rows[0].status}.`,
        ];
      } else {
        await client.query(
          `UPDATE leave_requests
           SET status = $1,
               manager_comment = $2,
               manager_reviewed_by = $3,
               manager_reviewed_at = $4::timestamp,
               updated_at = $4::timestamp
           WHERE id = $5 AND company_id = $6`,
          [newStatus, managerComment, auth.employeeId, nowUtc, requestId, auth.companyId]
        );
      }
    }

    if (resultError) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }

  if (resultError) return { error: resultError };

  const row = await fetchLeaveRequestById(requestId, auth.companyId);
  const effectiveOutcome = workflowFinalStatus !== undefined ? workflowFinalStatus : newStatus;

  if (effectiveOutcome === 'approved') {
    // Workflow chain fully resolved via this action — same final-approval emails as the admin path.
    leaveEmailNotification.notifyLeaveApproved(auth.companyId, row).catch((error) => {
      console.error('Leave approved email error:', error);
    });
    if (balanceBeforeApproval) {
      const balanceRow = await fetchLeaveBalanceRowForRequest(
        auth.companyId,
        row.employee_id,
        row.leave_policy_id,
        approvedFromDateKey || toDateKey(row.from_date)
      );
      if (balanceRow) {
        leaveEmailNotification
          .notifyLeaveBalanceUpdated(auth.companyId, balanceRow, {
            previousAvailable: balanceBeforeApproval.available_days,
            previousUsed: balanceBeforeApproval.used_days,
            previousTotal: balanceBeforeApproval.total_days,
          })
          .catch((error) => {
            console.error('Leave balance updated email error:', error);
          });
      }
    }
  } else if (effectiveOutcome === 'manager_approved' || effectiveOutcome === null) {
    leaveEmailNotification.notifyLeaveManagerApproved(auth.companyId, row).catch((error) => {
      console.error('Leave manager approved email error:', error);
    });
  } else if (effectiveOutcome === 'rejected') {
    leaveEmailNotification.notifyLeaveRejectedByManager(auth.companyId, row, managerComment).catch((error) => {
      console.error('Leave rejected by manager email error:', error);
    });
  }

  const [item] = await enrichTeamItemsWithActionability(
    [mapLeaveRequestRow(row, { includeEmployee: true })],
    auth.companyId,
    auth.user.id
  );
  return { leave_request: item };
}

module.exports = {
  getAuthenticatedCompanyAdmin,
  parsePositiveInt,
  createLeaveRequest,
  getMyLeaveRequests,
  getMyLeaveRequestById,
  getTeamLeaveRequests,
  getTeamLeaveRequestById,
  updateTeamLeaveRequestStatus,
  getLeaveRequests,
  getLeaveRequestById,
  updateLeaveRequestStatus,
  cancelMyLeaveRequest,
};
