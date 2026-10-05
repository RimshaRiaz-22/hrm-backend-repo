const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const {
  sendHrRequestSubmittedEmail,
  sendHrRequestManagerApprovedEmail,
  sendHrRequestApprovedEmail,
  sendHrRequestRejectedEmail,
  sendAttendanceCorrectionSubmittedEmail,
  sendAttendanceCorrectionApprovedEmail,
  sendAttendanceCorrectionRejectedEmail,
  getRecipientBlockReason,
} = require('./email.service');
const pushNotification = require('./pushNotification.service');
const deviceTokenService = require('./deviceToken.service');

const REQUEST_REVIEWER_ROLES = [
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
];

const REQUEST_TYPE_LABELS = {
  attendance_correction: 'Attendance Correction',
  wfh: 'Work From Home',
  resignation: 'Resignation',
  loan: 'Loan',
  advance: 'Advance',
  expense: 'Expense',
  pf_temporary: 'PF Temporary Withdrawal',
  pf_permanent: 'PF Permanent Withdrawal',
};

function getRequestTypeLabel(requestType) {
  return REQUEST_TYPE_LABELS[requestType] || 'Request';
}

function formatDisplayDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDisplayDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function buildRequestEmailDetails(requestItem) {
  const details = requestItem.details || {};
  const employeeName = requestItem.employee_name || 'Employee';
  const base = { employeeName };

  if (requestItem.request_type === 'attendance_correction') {
    return {
      ...base,
      correctionDate: details.correction_date ?? null,
      originalCheckIn: details.original_check_in ?? null,
      originalCheckOut: details.original_check_out ?? null,
      correctedCheckIn: details.corrected_check_in ?? null,
      correctedCheckOut: details.corrected_check_out ?? null,
      reason: details.reason ?? null,
    };
  }

  const summaryLines = [];

  if (requestItem.request_type === 'wfh') {
    const dates = Array.isArray(details.dates)
      ? details.dates.map((date) => formatDisplayDate(date)).filter(Boolean).join(', ')
      : '';
    if (dates) summaryLines.push({ label: 'WFH dates', value: dates });
    if (details.work_plan) summaryLines.push({ label: 'Work plan', value: details.work_plan });
    if (details.reason) summaryLines.push({ label: 'Reason', value: details.reason });
    return { ...base, summaryLines, reason: details.reason ?? null };
  }

  if (requestItem.request_type === 'resignation') {
    if (details.last_intended_date) {
      summaryLines.push({
        label: 'Last intended date',
        value: formatDisplayDate(details.last_intended_date),
      });
    }
    if (details.calculated_last_working_date) {
      summaryLines.push({
        label: 'Last working date',
        value: formatDisplayDate(details.calculated_last_working_date),
      });
    }
    if (details.notice_period_days != null) {
      summaryLines.push({ label: 'Notice period (days)', value: String(details.notice_period_days) });
    }
    if (details.reason) summaryLines.push({ label: 'Reason', value: details.reason });
    return { ...base, summaryLines, reason: details.reason ?? null };
  }

  if (requestItem.request_type === 'loan' || requestItem.request_type === 'advance') {
    if (details.amount != null) summaryLines.push({ label: 'Amount', value: formatMoney(details.amount) });
    if (details.repayment_type) {
      summaryLines.push({ label: 'Repayment type', value: details.repayment_type.replace(/_/g, ' ') });
    }
    if (details.tenure_months != null) {
      summaryLines.push({ label: 'Tenure (months)', value: String(details.tenure_months) });
    }
    if (details.emi_amount != null) {
      summaryLines.push({ label: 'EMI amount', value: formatMoney(details.emi_amount) });
    }
    if (details.repayment_start) {
      summaryLines.push({ label: 'Repayment start', value: details.repayment_start });
    }
    if (details.purpose) summaryLines.push({ label: 'Purpose', value: details.purpose });
    return { ...base, summaryLines, reason: details.purpose ?? null };
  }

  if (requestItem.request_type === 'expense') {
    if (details.category_name || details.category) {
      summaryLines.push({ label: 'Category', value: details.category_name || details.category });
    }
    if (details.total_amount != null) {
      summaryLines.push({ label: 'Total amount', value: formatMoney(details.total_amount) });
    }
    if (Array.isArray(details.items) && details.items.length > 0) {
      summaryLines.push({ label: 'Line items', value: String(details.items.length) });
    }
    return { ...base, summaryLines };
  }

  if (requestItem.request_type === 'pf_temporary') {
    if (details.amount != null) summaryLines.push({ label: 'Amount', value: formatMoney(details.amount) });
    if (details.recovery_method) {
      summaryLines.push({ label: 'Recovery method', value: details.recovery_method.replace(/_/g, ' ') });
    }
    if (details.tenure_months != null) {
      summaryLines.push({ label: 'Tenure (months)', value: String(details.tenure_months) });
    }
    if (details.emi_amount != null) {
      summaryLines.push({ label: 'EMI amount', value: formatMoney(details.emi_amount) });
    }
    if (details.purpose) summaryLines.push({ label: 'Purpose', value: details.purpose });
    return { ...base, summaryLines, reason: details.purpose ?? null };
  }

  if (requestItem.request_type === 'pf_permanent') {
    if (details.amount != null) summaryLines.push({ label: 'Amount', value: formatMoney(details.amount) });
    if (details.withdrawal_date) {
      summaryLines.push({ label: 'Withdrawal date', value: formatDisplayDate(details.withdrawal_date) });
    }
    if (details.payout_method) {
      summaryLines.push({ label: 'Payout method', value: details.payout_method.replace(/_/g, ' ') });
    }
    if (details.purpose) summaryLines.push({ label: 'Purpose', value: details.purpose });
    return { ...base, summaryLines, reason: details.purpose ?? null };
  }

  if (requestItem.submitted_at) {
    summaryLines.push({ label: 'Submitted at', value: formatDisplayDateTime(requestItem.submitted_at) });
  }

  return { ...base, summaryLines };
}

async function fetchCompanyBranding(companyId) {
  const { fetchCompanyBranding: loadBranding } = require('../utils/companyBranding');
  const branding = await loadBranding(companyId);
  return {
    companyId: companyId || null,
    companyName: branding.companyName || 'HRM',
    companyLogoUrl: branding.companyLogoUrl,
  };
}

async function fetchRequestReviewerEmails(companyId) {
  const result = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(u.email)) AS email
     FROM users u
     WHERE u.company_id = $1
       AND u.is_active = true
       AND u.email IS NOT NULL
       AND TRIM(u.email) <> ''
       AND u.role = ANY($2::text[])`,
    [companyId, REQUEST_REVIEWER_ROLES]
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
  return Array.from(new Set(result.rows.map((row) => Number(row.manager_id))));
}

function buildRequestEmailPayload(
  requestItem,
  branding,
  { recipientName, hrComment, senderEmail, asEmployeeSender = false, fromEmail } = {}
) {
  const employeeName = requestItem.employee_name || 'Employee';
  const emailDetails = buildRequestEmailDetails(requestItem);
  if (hrComment !== undefined) {
    emailDetails.hrComment = hrComment;
  } else if (requestItem.hr_comment) {
    emailDetails.hrComment = requestItem.hr_comment;
  } else if (requestItem.manager_comment) {
    emailDetails.hrComment = requestItem.manager_comment;
  }

  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName,
    employeeName,
    requestTypeLabel: getRequestTypeLabel(requestItem.request_type),
    senderName: asEmployeeSender ? employeeName : null,
    senderEmail: asEmployeeSender
      ? senderEmail || String(requestItem.employee_email || '').trim().toLowerCase() || null
      : null,
    fromEmail: asEmployeeSender ? null : fromEmail || null,
    hrComment: emailDetails.hrComment ?? null,
    details: emailDetails,
  };
}

function isAttendanceCorrection(requestItem) {
  return requestItem.request_type === 'attendance_correction';
}

function buildAttendanceCorrectionDedicatedPayload(
  requestItem,
  branding,
  { recipientName, hrComment, senderEmail, asEmployeeSender = false, fromEmail } = {}
) {
  const employeeName = requestItem.employee_name || 'Employee';
  const resolvedHrComment =
    hrComment !== undefined
      ? hrComment
      : requestItem.hr_comment ?? requestItem.manager_comment ?? null;

  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName,
    employeeName,
    senderName: asEmployeeSender ? employeeName : null,
    senderEmail: asEmployeeSender
      ? senderEmail || String(requestItem.employee_email || '').trim().toLowerCase() || null
      : null,
    fromEmail: asEmployeeSender ? null : fromEmail || null,
    hrComment: resolvedHrComment,
    details: requestItem.details || {},
  };
}

async function sendEmailSafely(sendFn, toEmail, payload, label) {
  if (!toEmail) return;
  const blockReason = getRecipientBlockReason(toEmail);
  if (blockReason) {
    console.error(`Request email (${label}) skipped for ${toEmail}: ${blockReason}`);
    return;
  }
  try {
    const result = await sendFn(toEmail, payload);
    if (!result?.sent) {
      console.error(`Request email (${label}) not sent to ${toEmail}: ${result?.reason || 'unknown error'}`);
    }
  } catch (error) {
    console.error(`Request email (${label}) error for ${toEmail}:`, error);
  }
}

async function notifyRequestSubmitted(companyId, requestItem) {
  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const reviewerEmails = await fetchRequestReviewerEmails(companyId);

  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, requestItem.employee_id)) ||
    String(requestItem.employee_email || '').trim().toLowerCase() ||
    null;

  const attendanceCorrection = isAttendanceCorrection(requestItem);
  const payload = attendanceCorrection
    ? buildAttendanceCorrectionDedicatedPayload(requestItem, branding, {
        recipientName: 'Team',
        senderEmail: employeeEmail,
        asEmployeeSender: true,
      })
    : buildRequestEmailPayload(requestItem, branding, {
        recipientName: 'Team',
        senderEmail: employeeEmail,
        asEmployeeSender: true,
      });
  const submittedSendFn = attendanceCorrection
    ? sendAttendanceCorrectionSubmittedEmail
    : sendHrRequestSubmittedEmail;

  if (reviewerEmails.length === 0) {
    console.error(`Request submitted email skipped: no reviewer emails for company ${companyId}`);
  } else {
    await Promise.all(
      reviewerEmails.map((email) =>
        sendEmailSafely(submittedSendFn, email, payload, 'submitted')
      )
    );
  }

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, REQUEST_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: `${typeLabel} Request`,
    body: `${requestItem.employee_name || 'An employee'} submitted a ${typeLabel.toLowerCase()} request.`,
    data: {
      type: `${requestItem.request_type}_submitted`,
      request_id: String(requestItem.id),
      request_type: requestItem.request_type,
      screen: 'PendingRequests',
    },
    label: `${requestItem.request_type}-submitted`,
  });

  await notifyRequestLineManagerSubmitted(companyId, requestItem);
}

async function notifyRequestLineManagerSubmitted(companyId, requestItem) {
  const lineManagerEmployeeIds = await fetchLineManagerEmployeeIds(companyId, requestItem.employee_id);
  if (lineManagerEmployeeIds.length === 0) return;

  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, requestItem.employee_id)) ||
    String(requestItem.employee_email || '').trim().toLowerCase() ||
    null;

  const attendanceCorrection = isAttendanceCorrection(requestItem);
  const submittedSendFn = attendanceCorrection
    ? sendAttendanceCorrectionSubmittedEmail
    : sendHrRequestSubmittedEmail;

  for (const managerEmployeeId of lineManagerEmployeeIds) {
    const managerEmail = await fetchEmployeeAccountEmail(companyId, managerEmployeeId);
    const payload = attendanceCorrection
      ? buildAttendanceCorrectionDedicatedPayload(requestItem, branding, {
          recipientName: 'Line Manager',
          senderEmail: employeeEmail,
          asEmployeeSender: true,
        })
      : buildRequestEmailPayload(requestItem, branding, {
          recipientName: 'Line Manager',
          senderEmail: employeeEmail,
          asEmployeeSender: true,
        });

    if (!managerEmail) {
      console.error(
        `Request line manager email skipped: no email for manager employee ${managerEmployeeId}`
      );
    } else {
      await sendEmailSafely(submittedSendFn, managerEmail, payload, 'submitted-line-manager');
    }

    await pushNotification.sendNotificationToEmployee(companyId, managerEmployeeId, {
      title: `${typeLabel} Request`,
      body: `${requestItem.employee_name || 'An employee'} submitted a ${typeLabel.toLowerCase()} request.`,
      data: {
        type: `${requestItem.request_type}_submitted_team`,
        request_id: String(requestItem.id),
        request_type: requestItem.request_type,
        screen: 'TeamRequests',
      },
      label: `${requestItem.request_type}-submitted-line-manager`,
    });
  }
}

async function notifyRequestManagerApproved(companyId, requestItem) {
  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const reviewerEmails = await fetchRequestReviewerEmails(companyId);

  const payload = buildRequestEmailPayload(requestItem, branding, {
    recipientName: 'Team',
    hrComment: requestItem.manager_comment ?? null,
  });

  if (reviewerEmails.length === 0) {
    console.error(`Request manager approved email skipped: no reviewer emails for company ${companyId}`);
  } else {
    await Promise.all(
      reviewerEmails.map((email) =>
        sendEmailSafely(sendHrRequestManagerApprovedEmail, email, payload, 'manager-approved')
      )
    );
  }

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, REQUEST_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: `${typeLabel} Awaiting Final Approval`,
    body: `${requestItem.employee_name || 'An employee'}'s ${typeLabel.toLowerCase()} request was approved by the line manager.`,
    data: {
      type: `${requestItem.request_type}_manager_approved`,
      request_id: String(requestItem.id),
      request_type: requestItem.request_type,
      screen: 'PendingRequests',
    },
    label: `${requestItem.request_type}-manager-approved`,
  });
}

async function notifyRequestRejectedByManager(companyId, requestItem, managerComment) {
  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, requestItem.employee_id)) ||
    String(requestItem.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(
      `Request rejected email skipped: no employee email for employee ${requestItem.employee_id}`
    );
  } else {
    const payload = buildRequestEmailPayload(requestItem, branding, {
      recipientName: requestItem.employee_name || 'Employee',
      hrComment: managerComment ?? requestItem.manager_comment ?? null,
    });
    await sendEmailSafely(sendHrRequestRejectedEmail, employeeEmail, payload, 'rejected-by-manager');
  }

  await pushNotification.sendNotificationToEmployee(companyId, requestItem.employee_id, {
    title: `${typeLabel} Rejected`,
    body: `Your ${typeLabel.toLowerCase()} request was rejected by your line manager.`,
    data: {
      type: `${requestItem.request_type}_rejected`,
      request_id: String(requestItem.id),
      request_type: requestItem.request_type,
      screen: 'MyRequests',
    },
    label: `${requestItem.request_type}-rejected-by-manager`,
  });
}

async function notifyRequestApproved(companyId, requestItem) {
  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const { fetchUserEmailById, fetchCompanyHrContactEmail } = require('../utils/companyBranding');
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, requestItem.employee_id)) ||
    String(requestItem.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(
      `Request approved email skipped: no employee email for employee ${requestItem.employee_id}`
    );
  } else {
    const statusFromEmail =
      (await fetchUserEmailById(requestItem.reviewed_by)) ||
      (await fetchCompanyHrContactEmail(companyId)) ||
      null;

    const attendanceCorrection = isAttendanceCorrection(requestItem);
    const payload = attendanceCorrection
      ? buildAttendanceCorrectionDedicatedPayload(requestItem, branding, {
          recipientName: requestItem.employee_name || 'Employee',
          fromEmail: statusFromEmail,
        })
      : buildRequestEmailPayload(requestItem, branding, {
          recipientName: requestItem.employee_name || 'Employee',
          fromEmail: statusFromEmail,
        });
    const approvedSendFn = attendanceCorrection
      ? sendAttendanceCorrectionApprovedEmail
      : sendHrRequestApprovedEmail;
    await sendEmailSafely(approvedSendFn, employeeEmail, payload, 'approved');
  }

  await pushNotification.sendNotificationToEmployee(companyId, requestItem.employee_id, {
    title: `${typeLabel} Approved`,
    body: `Your ${typeLabel.toLowerCase()} request has been approved.`,
    data: {
      type: `${requestItem.request_type}_approved`,
      request_id: String(requestItem.id),
      request_type: requestItem.request_type,
      screen: 'MyRequests',
    },
    label: `${requestItem.request_type}-approved`,
  });
}

async function notifyRequestRejected(companyId, requestItem, hrComment) {
  const branding = await fetchCompanyBranding(companyId);
  const typeLabel = getRequestTypeLabel(requestItem.request_type);
  const { fetchUserEmailById, fetchCompanyHrContactEmail } = require('../utils/companyBranding');
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, requestItem.employee_id)) ||
    String(requestItem.employee_email || '').trim().toLowerCase() ||
    null;

  if (!employeeEmail) {
    console.error(
      `Request rejected email skipped: no employee email for employee ${requestItem.employee_id}`
    );
  } else {
    const statusFromEmail =
      (await fetchUserEmailById(requestItem.reviewed_by)) ||
      (await fetchCompanyHrContactEmail(companyId)) ||
      null;

    const attendanceCorrection = isAttendanceCorrection(requestItem);
    const payload = attendanceCorrection
      ? buildAttendanceCorrectionDedicatedPayload(requestItem, branding, {
          recipientName: requestItem.employee_name || 'Employee',
          hrComment: hrComment ?? requestItem.hr_comment ?? null,
          fromEmail: statusFromEmail,
        })
      : buildRequestEmailPayload(requestItem, branding, {
          recipientName: requestItem.employee_name || 'Employee',
          hrComment: hrComment ?? requestItem.hr_comment ?? null,
          fromEmail: statusFromEmail,
        });
    const rejectedSendFn = attendanceCorrection
      ? sendAttendanceCorrectionRejectedEmail
      : sendHrRequestRejectedEmail;
    await sendEmailSafely(rejectedSendFn, employeeEmail, payload, 'rejected');
  }

  await pushNotification.sendNotificationToEmployee(companyId, requestItem.employee_id, {
    title: `${typeLabel} Rejected`,
    body: `Your ${typeLabel.toLowerCase()} request was rejected.`,
    data: {
      type: `${requestItem.request_type}_rejected`,
      request_id: String(requestItem.id),
      request_type: requestItem.request_type,
      screen: 'MyRequests',
    },
    label: `${requestItem.request_type}-rejected`,
  });
}

const notifyAttendanceCorrectionSubmitted = notifyRequestSubmitted;
const notifyAttendanceCorrectionLineManagerSubmitted = notifyRequestLineManagerSubmitted;
const notifyAttendanceCorrectionManagerApproved = notifyRequestManagerApproved;
const notifyAttendanceCorrectionRejectedByManager = notifyRequestRejectedByManager;
const notifyAttendanceCorrectionApproved = notifyRequestApproved;
const notifyAttendanceCorrectionRejected = notifyRequestRejected;

module.exports = {
  notifyAttendanceCorrectionSubmitted,
  notifyAttendanceCorrectionLineManagerSubmitted,
  notifyAttendanceCorrectionManagerApproved,
  notifyAttendanceCorrectionRejectedByManager,
  notifyAttendanceCorrectionApproved,
  notifyAttendanceCorrectionRejected,
  notifyRequestSubmitted,
  notifyRequestLineManagerSubmitted,
  notifyRequestManagerApproved,
  notifyRequestRejectedByManager,
  notifyRequestApproved,
  notifyRequestRejected,
};
