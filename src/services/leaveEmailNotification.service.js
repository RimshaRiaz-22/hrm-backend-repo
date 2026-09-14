const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { toDateKey, inclusiveCalendarDays } = require('../utils/dateTime');
const {
  sendLeaveRequestSubmittedEmail,
  sendLeaveRequestReceivedEmail,
  sendLeaveApprovedEmail,
  sendLeaveRejectedEmail,
  sendLeaveCancelledEmail,
  sendLeaveBalanceUpdatedEmail,
  getRecipientBlockReason,
} = require('./email.service');
const pushNotification = require('./pushNotification.service');
const deviceTokenService = require('./deviceToken.service');

const LEAVE_REVIEWER_ROLES = [
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
];

async function fetchCompanyBranding(companyId) {
  const { fetchCompanyBranding: loadBranding } = require('../utils/companyBranding');
  const branding = await loadBranding(companyId);
  return {
    companyId: companyId || null,
    companyName: branding.companyName || 'HRM',
    companyLogoUrl: branding.companyLogoUrl,
  };
}

async function fetchLeaveReviewerEmails(companyId) {
  const result = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(u.email)) AS email
     FROM users u
     WHERE u.company_id = $1
       AND u.is_active = true
       AND u.email IS NOT NULL
       AND TRIM(u.email) <> ''
       AND u.role = ANY($2::text[])`,
    [companyId, LEAVE_REVIEWER_ROLES]
  );
  return result.rows.map((row) => row.email).filter(Boolean);
}

async function fetchEmployeeAccountEmail(companyId, employeeId) {
  const result = await pool.query(
    `SELECT LOWER(TRIM(email)) AS email
     FROM users
     WHERE company_id = $1
       AND employee_id = $2
       AND is_active = true
       AND email IS NOT NULL
       AND TRIM(email) <> ''
     LIMIT 1`,
    [companyId, employeeId]
  );
  return result.rows[0]?.email || null;
}

async function fetchLineManagerEmployeeIds(companyId, employeeId) {
  const result = await pool.query(
    `SELECT elm.manager_id
     FROM employee_line_managers elm
     WHERE elm.company_id = $1
       AND elm.employee_id = $2`,
    [companyId, employeeId]
  );
  const legacy = await pool.query(
    `SELECT ejd.line_manager_id
     FROM employee_job_details ejd
     WHERE ejd.company_id = $1
       AND ejd.employee_id = $2
       AND ejd.line_manager_id IS NOT NULL
     LIMIT 1`,
    [companyId, employeeId]
  );
  const ids = new Set(result.rows.map((row) => Number(row.manager_id)));
  const legacyId = legacy.rows[0]?.line_manager_id;
  if (legacyId) ids.add(Number(legacyId));
  return Array.from(ids);
}

function formatEmployeeNameFromRow(row) {
  const name = [row.employee_first_name, row.employee_last_name].filter(Boolean).join(' ').trim();
  return name || 'Employee';
}

function buildLeaveDateRange(row) {
  const fromDate = toDateKey(row.from_date);
  const toDate = toDateKey(row.to_date);
  return fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;
}

/** Inclusive calendar days for leave emails (same day = 1, not billable/holiday math). */
function formatLeaveTotalDays(row) {
  const calendarDays = inclusiveCalendarDays(toDateKey(row.from_date), toDateKey(row.to_date));
  if (calendarDays != null) return calendarDays;
  if (row.total_days == null || row.total_days === '') return row.total_days;
  const n = Number(row.total_days);
  return Number.isFinite(n) ? n : row.total_days;
}

function buildLeavePayloadFromRow(
  row,
  branding,
  { recipientName, hrComment, balanceSummary, senderEmail, asEmployeeSender = false, fromEmail } = {}
) {
  const employeeName = formatEmployeeNameFromRow(row);
  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName,
    employeeName,
    // Only employee → HR emails should present the employee as sender
    senderName: asEmployeeSender ? employeeName : null,
    senderEmail: asEmployeeSender
      ? senderEmail || String(row.employee_email || '').trim().toLowerCase() || null
      : null,
    fromEmail: asEmployeeSender ? null : fromEmail || null,
    leavePolicyName: row.leave_policy_name || 'Leave',
    fromDate: toDateKey(row.from_date),
    toDate: toDateKey(row.to_date),
    totalDays: formatLeaveTotalDays(row),
    reason: row.reason,
    hrComment: hrComment !== undefined ? hrComment : row.hr_comment ?? null,
    balanceSummary: balanceSummary ?? null,
  };
}

function buildBalancePayloadFromRow(row, branding, { recipientName, balanceChangeNote, availableDays } = {}) {
  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName,
    employeeName: formatEmployeeNameFromRow(row),
    leavePolicyName: row.leave_policy_name || 'Leave',
    fromDate: null,
    toDate: null,
    totalDays: row.total_days,
    reason: null,
    availableDays: availableDays ?? row.available_days,
    balanceChangeNote,
    balanceSummary: `Total: ${row.total_days} | Used: ${row.used_days} | Available: ${availableDays ?? row.available_days}`,
  };
}

async function sendEmailSafely(sendFn, toEmail, payload, label) {
  if (!toEmail) return;
  const blockReason = getRecipientBlockReason(toEmail);
  if (blockReason) {
    console.error(`Leave email (${label}) skipped for ${toEmail}: ${blockReason}`);
    return;
  }
  try {
    const result = await sendFn(toEmail, payload);
    if (!result?.sent) {
      console.error(`Leave email (${label}) not sent to ${toEmail}: ${result?.reason || 'unknown error'}`);
    }
  } catch (error) {
    console.error(`Leave email (${label}) error for ${toEmail}:`, error);
  }
}

async function notifyLeaveRequestSubmitted(companyId, leaveRow) {
  const branding = await fetchCompanyBranding(companyId);
  const reviewerEmails = await fetchLeaveReviewerEmails(companyId);
  if (reviewerEmails.length === 0) {
    console.error(`Leave request submitted email skipped: no reviewer emails for company ${companyId}`);
    return;
  }

  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: 'Team',
    senderEmail: employeeEmail,
    asEmployeeSender: true,
  });

  await Promise.all(
    reviewerEmails.map((email) => sendEmailSafely(sendLeaveRequestSubmittedEmail, email, payload, 'submitted'))
  );

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, LEAVE_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: 'New Leave Request',
    body: `${formatEmployeeNameFromRow(leaveRow)} submitted ${leaveRow.leave_policy_name || 'leave'} (${buildLeaveDateRange(leaveRow)}).`,
    data: {
      type: 'leave_submitted',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequests',
    },
    label: 'leave-submitted',
  });
}

async function notifyLeaveRequestReceived(companyId, leaveRow) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(
      `Leave request received email skipped: no employee email for employee ${leaveRow.employee_id}`
    );
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: formatEmployeeNameFromRow(leaveRow),
  });
  await sendEmailSafely(sendLeaveRequestReceivedEmail, employeeEmail, payload, 'received');

  await pushNotification.sendNotificationToEmployee(companyId, leaveRow.employee_id, {
    title: 'Leave Request Submitted',
    body: `Your ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) was submitted successfully.`,
    data: {
      type: 'leave_received',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequestDetails',
    },
    label: 'leave-received',
  });
}

async function notifyLineManagerLeaveRequestSubmitted(companyId, leaveRow) {
  const lineManagerEmployeeIds = await fetchLineManagerEmployeeIds(companyId, leaveRow.employee_id);
  if (lineManagerEmployeeIds.length === 0) return;

  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  for (const lineManagerEmployeeId of lineManagerEmployeeIds) {
    const managerEmail = await fetchEmployeeAccountEmail(companyId, lineManagerEmployeeId);
    if (!managerEmail) {
      console.error(
        `Leave request line manager email skipped: no email for manager employee ${lineManagerEmployeeId}`
      );
    } else {
      const payload = buildLeavePayloadFromRow(leaveRow, branding, {
        recipientName: 'Line Manager',
        senderEmail: employeeEmail,
        asEmployeeSender: true,
      });
      await sendEmailSafely(sendLeaveRequestSubmittedEmail, managerEmail, payload, 'submitted-line-manager');
    }

    await pushNotification.sendNotificationToEmployee(companyId, lineManagerEmployeeId, {
      title: 'New Leave Request',
      body: `${formatEmployeeNameFromRow(leaveRow)} submitted ${leaveRow.leave_policy_name || 'leave'} (${buildLeaveDateRange(leaveRow)}).`,
      data: {
        type: 'leave_submitted_team',
        leave_id: String(leaveRow.id),
        screen: 'TeamLeaveRequests',
      },
      label: 'leave-submitted-line-manager',
    });
  }
}

async function notifyLeaveManagerApproved(companyId, leaveRow) {
  const branding = await fetchCompanyBranding(companyId);
  const reviewerEmails = await fetchLeaveReviewerEmails(companyId);
  if (reviewerEmails.length === 0) {
    console.error(
      `Leave manager approved email skipped: no reviewer emails for company ${companyId}`
    );
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: 'Team',
    hrComment: leaveRow.manager_comment ?? null,
  });

  await Promise.all(
    reviewerEmails.map((email) =>
      sendEmailSafely(sendLeaveRequestSubmittedEmail, email, payload, 'manager-approved')
    )
  );

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, LEAVE_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: 'Leave Awaiting Final Approval',
    body: `${formatEmployeeNameFromRow(leaveRow)}'s ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) was approved by the line manager.`,
    data: {
      type: 'leave_manager_approved',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequests',
    },
    label: 'leave-manager-approved',
  });
}

async function notifyLeaveRejectedByManager(companyId, leaveRow, managerComment) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(`Leave rejected email skipped: no employee email for employee ${leaveRow.employee_id}`);
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: formatEmployeeNameFromRow(leaveRow),
    hrComment: managerComment ?? leaveRow.manager_comment ?? null,
  });
  await sendEmailSafely(sendLeaveRejectedEmail, employeeEmail, payload, 'rejected-by-manager');

  await pushNotification.sendNotificationToEmployee(companyId, leaveRow.employee_id, {
    title: 'Leave Rejected',
    body: `Your ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) was rejected by your line manager.`,
    data: {
      type: 'leave_rejected',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequestDetails',
    },
    label: 'leave-rejected-by-manager',
  });
}

async function notifyLeaveApproved(companyId, leaveRow) {
  const branding = await fetchCompanyBranding(companyId);
  const { fetchCompanyHrContactEmail } = require('../utils/companyBranding');
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(`Leave approved email skipped: no employee email for employee ${leaveRow.employee_id}`);
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: formatEmployeeNameFromRow(leaveRow),
    hrComment: leaveRow.hr_comment ?? null,
    fromEmail: await fetchCompanyHrContactEmail(companyId),
  });
  await sendEmailSafely(sendLeaveApprovedEmail, employeeEmail, payload, 'approved');

  await pushNotification.sendNotificationToEmployee(companyId, leaveRow.employee_id, {
    title: 'Leave Approved',
    body: `Your ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) has been approved.`,
    data: {
      type: 'leave_approved',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequestDetails',
    },
    label: 'leave-approved',
  });
}

async function notifyLeaveRejected(companyId, leaveRow, hrComment) {
  const branding = await fetchCompanyBranding(companyId);
  const { fetchCompanyHrContactEmail } = require('../utils/companyBranding');
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(`Leave rejected email skipped: no employee email for employee ${leaveRow.employee_id}`);
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: formatEmployeeNameFromRow(leaveRow),
    hrComment: hrComment ?? leaveRow.hr_comment ?? null,
    fromEmail: await fetchCompanyHrContactEmail(companyId),
  });
  await sendEmailSafely(sendLeaveRejectedEmail, employeeEmail, payload, 'rejected');

  await pushNotification.sendNotificationToEmployee(companyId, leaveRow.employee_id, {
    title: 'Leave Rejected',
    body: `Your ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) was rejected.`,
    data: {
      type: 'leave_rejected',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequestDetails',
    },
    label: 'leave-rejected',
  });
}

async function notifyLeaveCancelled(companyId, leaveRow) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, leaveRow.employee_id)) ||
    String(leaveRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(`Leave cancelled email skipped: no employee email for employee ${leaveRow.employee_id}`);
    return;
  }

  const payload = buildLeavePayloadFromRow(leaveRow, branding, {
    recipientName: formatEmployeeNameFromRow(leaveRow),
  });
  await sendEmailSafely(sendLeaveCancelledEmail, employeeEmail, payload, 'cancelled');

  await pushNotification.sendNotificationToEmployee(companyId, leaveRow.employee_id, {
    title: 'Leave Cancelled',
    body: `Your ${leaveRow.leave_policy_name || 'leave'} request (${buildLeaveDateRange(leaveRow)}) was cancelled.`,
    data: {
      type: 'leave_cancelled',
      leave_id: String(leaveRow.id),
      screen: 'LeaveRequestDetails',
    },
    label: 'leave-cancelled',
  });
}

async function notifyLeaveBalanceUpdated(companyId, balanceRow, { previousAvailable, previousUsed, previousTotal } = {}) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, balanceRow.employee_id)) ||
    String(balanceRow.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(
      `Leave balance updated email skipped: no employee email for employee ${balanceRow.employee_id}`
    );
    return;
  }

  const availableDays = Number(balanceRow.available_days);
  const usedDays = Number(balanceRow.used_days);
  const totalDays = Number(balanceRow.total_days);
  const changes = [];

  if (previousTotal != null && Number(previousTotal) !== totalDays) {
    changes.push(`total days changed from ${previousTotal} to ${totalDays}`);
  }
  if (previousUsed != null && Number(previousUsed) !== usedDays) {
    changes.push(`used days changed from ${previousUsed} to ${usedDays}`);
  }
  if (previousAvailable != null && Number(previousAvailable) !== availableDays) {
    changes.push(`available days changed from ${previousAvailable} to ${availableDays}`);
  }

  const payload = buildBalancePayloadFromRow(balanceRow, branding, {
    recipientName: formatEmployeeNameFromRow(balanceRow),
    availableDays,
    balanceChangeNote:
      changes.length > 0
        ? `Updated balance for ${balanceRow.leave_policy_name || 'leave policy'} (${balanceRow.year}): ${changes.join('; ')}.`
        : `Updated balance for ${balanceRow.leave_policy_name || 'leave policy'} (${balanceRow.year}).`,
  });

  await sendEmailSafely(sendLeaveBalanceUpdatedEmail, employeeEmail, payload, 'balance-updated');

  await pushNotification.sendNotificationToEmployee(companyId, balanceRow.employee_id, {
    title: 'Leave Balance Updated',
    body: payload.balanceChangeNote,
    data: {
      type: 'leave_balance_updated',
      leave_policy: String(balanceRow.leave_policy_name || 'leave'),
      year: String(balanceRow.year),
      screen: 'LeaveBalance',
    },
    label: 'leave-balance-updated',
  });
}

module.exports = {
  notifyLeaveRequestSubmitted,
  notifyLeaveRequestReceived,
  notifyLineManagerLeaveRequestSubmitted,
  notifyLeaveManagerApproved,
  notifyLeaveRejectedByManager,
  notifyLeaveApproved,
  notifyLeaveRejected,
  notifyLeaveCancelled,
  notifyLeaveBalanceUpdated,
};
