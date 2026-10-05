const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const {
  sendHrRequestSubmittedEmail,
  sendHrRequestManagerApprovedEmail,
  sendHrRequestApprovedEmail,
  sendHrRequestRejectedEmail,
} = require('./email.service');
const pushNotification = require('./pushNotification.service');
const deviceTokenService = require('./deviceToken.service');
const { DOCUMENT_TYPE_LABELS } = require('../constants/documentModule');

const REQUEST_REVIEWER_ROLES = [
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
];

function getDocumentTypeLabel(documentType) {
  return DOCUMENT_TYPE_LABELS[documentType] || 'Document';
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

function buildDocumentEmailPayload(documentRequest, branding, options = {}) {
  const employeeName = documentRequest.employee_name || 'Employee';
  const typeLabel = getDocumentTypeLabel(documentRequest.document_type);
  const comment =
    options.comment ??
    documentRequest.hr_comment ??
    documentRequest.manager_comment ??
    documentRequest.rejection_reason ??
    null;

  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName: options.recipientName || 'Team',
    employeeName,
    requestTypeLabel: 'Document Request',
    senderName: options.asEmployeeSender ? employeeName : null,
    senderEmail: options.asEmployeeSender
      ? options.senderEmail || String(documentRequest.employee_email || '').trim().toLowerCase() || null
      : null,
    hrComment: comment,
    details: {
      employeeName,
      documentType: typeLabel,
      purpose: documentRequest.purpose || null,
      addressedTo: documentRequest.addressed_to || null,
      note: documentRequest.note || null,
    },
  };
}

async function sendEmailSafely(sendFn, toEmail, payload, label) {
  if (!toEmail) return;
  try {
    const result = await sendFn(toEmail, payload);
    if (!result?.sent) {
      console.error(`Document email (${label}) not sent to ${toEmail}: ${result?.reason || 'unknown error'}`);
    }
  } catch (error) {
    console.error(`Document email (${label}) error for ${toEmail}:`, error);
  }
}

async function notifyDocumentRequestSubmitted(companyId, documentRequest) {
  const branding = await fetchCompanyBranding(companyId);
  const reviewerEmails = await fetchRequestReviewerEmails(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, documentRequest.employee_id)) ||
    String(documentRequest.employee_email || '').trim().toLowerCase() ||
    null;

  const payload = buildDocumentEmailPayload(documentRequest, branding, {
    recipientName: 'Team',
    senderEmail: employeeEmail,
    asEmployeeSender: true,
  });

  if (reviewerEmails.length === 0) {
    console.error(`Document submitted email skipped: no reviewer emails for company ${companyId}`);
  } else {
    await Promise.all(
      reviewerEmails.map((email) =>
        sendEmailSafely(sendHrRequestSubmittedEmail, email, payload, 'submitted')
      )
    );
  }

  const lineManagerEmployeeIds = await fetchLineManagerEmployeeIds(companyId, documentRequest.employee_id);
  for (const managerEmployeeId of lineManagerEmployeeIds) {
    const managerEmail = await fetchEmployeeAccountEmail(companyId, managerEmployeeId);
    const managerPayload = buildDocumentEmailPayload(documentRequest, branding, {
      recipientName: 'Line Manager',
      senderEmail: employeeEmail,
      asEmployeeSender: true,
    });
    await sendEmailSafely(sendHrRequestSubmittedEmail, managerEmail, managerPayload, 'submitted-line-manager');

    await pushNotification.sendNotificationToEmployee(companyId, managerEmployeeId, {
      title: 'Document Request',
      body: `${documentRequest.employee_name || 'An employee'} submitted a document request.`,
      data: {
        type: 'document_request_submitted_team',
        request_id: String(documentRequest.id),
        screen: 'TeamRequests',
      },
      label: 'document-request-submitted-line-manager',
    });
  }

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, REQUEST_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: 'Document Request',
    body: `${documentRequest.employee_name || 'An employee'} submitted a document request.`,
    data: {
      type: 'document_request_submitted',
      request_id: String(documentRequest.id),
      screen: 'PendingRequests',
    },
    label: 'document-request-submitted',
  });
}

async function notifyDocumentRequestManagerApproved(companyId, documentRequest) {
  const branding = await fetchCompanyBranding(companyId);
  const reviewerEmails = await fetchRequestReviewerEmails(companyId);
  const payload = buildDocumentEmailPayload(documentRequest, branding, {
    recipientName: 'Team',
    comment: documentRequest.manager_comment,
  });

  await Promise.all(
    reviewerEmails.map((email) =>
      sendEmailSafely(sendHrRequestManagerApprovedEmail, email, payload, 'manager-approved')
    )
  );

  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, documentRequest.employee_id)) ||
    String(documentRequest.employee_email || '').trim().toLowerCase() ||
    null;
  if (employeeEmail) {
    await sendEmailSafely(
      sendHrRequestManagerApprovedEmail,
      employeeEmail,
      buildDocumentEmailPayload(documentRequest, branding, {
        recipientName: employeeEmail,
        comment: documentRequest.manager_comment,
      }),
      'manager-approved-employee'
    );
  }
}

async function notifyDocumentRequestRejectedByManager(companyId, documentRequest, managerComment) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, documentRequest.employee_id)) ||
    String(documentRequest.employee_email || '').trim().toLowerCase() ||
    null;

  if (employeeEmail) {
    await sendEmailSafely(
      sendHrRequestRejectedEmail,
      employeeEmail,
      buildDocumentEmailPayload(documentRequest, branding, {
        recipientName: employeeEmail,
        comment: managerComment,
      }),
      'rejected-by-manager'
    );
  }
}

async function notifyDocumentRequestReady(companyId, documentRequest) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, documentRequest.employee_id)) ||
    String(documentRequest.employee_email || '').trim().toLowerCase() ||
    null;

  if (employeeEmail) {
    const payload = buildDocumentEmailPayload(documentRequest, branding, {
      recipientName: employeeEmail,
    });
    payload.highlightValue = 'Ready';
    await sendEmailSafely(sendHrRequestApprovedEmail, employeeEmail, payload, 'ready');
  }

  await pushNotification.sendNotificationToEmployee(companyId, documentRequest.employee_id, {
    title: 'Document Ready',
    body: 'Your document request is ready to download.',
    data: {
      type: 'document_request_ready',
      request_id: String(documentRequest.id),
      screen: 'MyRequests',
    },
    label: 'document-request-ready',
  });
}

async function notifyDocumentRequestRejected(companyId, documentRequest, rejectionReason) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    (await fetchEmployeeAccountEmail(companyId, documentRequest.employee_id)) ||
    String(documentRequest.employee_email || '').trim().toLowerCase() ||
    null;

  if (employeeEmail) {
    await sendEmailSafely(
      sendHrRequestRejectedEmail,
      employeeEmail,
      buildDocumentEmailPayload(documentRequest, branding, {
        recipientName: employeeEmail,
        comment: rejectionReason,
      }),
      'rejected'
    );
  }
}

module.exports = {
  notifyDocumentRequestSubmitted,
  notifyDocumentRequestManagerApproved,
  notifyDocumentRequestRejectedByManager,
  notifyDocumentRequestReady,
  notifyDocumentRequestRejected,
};
