const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const {
  sendHrRequestSubmittedEmail,
  sendHrRequestApprovedEmail,
  sendHrRequestRejectedEmail,
  sendDocumentRequirementRequestedEmail,
  sendCompanyDocumentUploadedEmail,
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

function getEmployeeFullName(document) {
  const employee = document?.employee || {};
  const fromParts = [employee.first_name, employee.last_name].filter(Boolean).join(' ').trim();
  return fromParts || document?.employee_name || 'Employee';
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

function buildDocumentSummaryLines(document) {
  const lines = [];
  if (document?.document_type) lines.push({ label: 'Document type', value: document.document_type });
  if (document?.title) lines.push({ label: 'Title', value: document.title });
  if (document?.note) lines.push({ label: 'Note', value: document.note });
  return lines;
}

function buildRequirementEmailPayload(document, branding, { recipientName, hrComment } = {}) {
  const employeeName = getEmployeeFullName(document);
  return {
    companyId: branding.companyId,
    companyName: branding.companyName,
    companyLogoUrl: branding.companyLogoUrl,
    recipientName: recipientName || 'Team',
    employeeName,
    requestTypeLabel: 'Document',
    hrComment: hrComment ?? document.rejection_reason ?? null,
    details: { employeeName, summaryLines: buildDocumentSummaryLines(document) },
  };
}

async function sendEmailSafely(sendFn, toEmail, payload, label) {
  if (!toEmail) return;
  const blockReason = getRecipientBlockReason(toEmail);
  if (blockReason) {
    console.error(`Document email (${label}) skipped for ${toEmail}: ${blockReason}`);
    return;
  }
  try {
    const result = await sendFn(toEmail, payload);
    if (!result?.sent) {
      console.error(`Document email (${label}) not sent to ${toEmail}: ${result?.reason || 'unknown error'}`);
    }
  } catch (error) {
    console.error(`Document email (${label}) error for ${toEmail}:`, error);
  }
}

/** HR requested a document from the employee. */
async function notifyDocumentRequested(companyId, document) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    document.employee?.email ||
    (await fetchEmployeeAccountEmail(companyId, document.employee_id)) ||
    null;

  if (!employeeEmail) {
    console.error(`Document requested email skipped: no email for employee ${document.employee_id}`);
  } else {
    const payload = buildRequirementEmailPayload(document, branding, {
      recipientName: getEmployeeFullName(document),
    });
    await sendEmailSafely(sendDocumentRequirementRequestedEmail, employeeEmail, payload, 'requested');
  }

  await pushNotification.sendNotificationToEmployee(companyId, document.employee_id, {
    title: 'Document Requested',
    body: `HR requested a document from you: ${document.title || 'Document'}.`,
    data: {
      type: 'document_requirement_requested',
      document_id: String(document.id),
      screen: 'RequiredDocuments',
    },
    label: 'document-requirement-requested',
  });
}

/** Employee uploaded the document — reviewers need to approve/reject it. */
async function notifyDocumentUploaded(companyId, document) {
  const branding = await fetchCompanyBranding(companyId);
  const reviewerEmails = await fetchRequestReviewerEmails(companyId);
  const employeeName = getEmployeeFullName(document);

  const payload = buildRequirementEmailPayload(document, branding, { recipientName: 'Team' });
  payload.senderName = employeeName;
  payload.senderEmail = document.employee?.email || null;

  if (reviewerEmails.length === 0) {
    console.error(`Document uploaded email skipped: no reviewer emails for company ${companyId}`);
  } else {
    await Promise.all(
      reviewerEmails.map((email) => sendEmailSafely(sendHrRequestSubmittedEmail, email, payload, 'uploaded'))
    );
  }

  const reviewerAccounts = await deviceTokenService.getReviewerUserAccounts(companyId, REQUEST_REVIEWER_ROLES);
  await pushNotification.sendNotificationToReviewers(companyId, reviewerAccounts, {
    title: 'Document Uploaded',
    body: `${employeeName} uploaded a document: ${document.title || 'Document'}. Review it now.`,
    data: {
      type: 'document_requirement_uploaded',
      document_id: String(document.id),
      screen: 'DocumentManagement',
    },
    label: 'document-requirement-uploaded',
  });
}

/** HR approved the uploaded document. */
async function notifyDocumentApproved(companyId, document) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    document.employee?.email ||
    (await fetchEmployeeAccountEmail(companyId, document.employee_id)) ||
    null;

  if (!employeeEmail) {
    console.error(`Document approved email skipped: no email for employee ${document.employee_id}`);
  } else {
    const payload = buildRequirementEmailPayload(document, branding, {
      recipientName: getEmployeeFullName(document),
    });
    await sendEmailSafely(sendHrRequestApprovedEmail, employeeEmail, payload, 'approved');
  }

  await pushNotification.sendNotificationToEmployee(companyId, document.employee_id, {
    title: 'Document Approved',
    body: `Your document "${document.title || 'Document'}" was approved.`,
    data: {
      type: 'document_requirement_approved',
      document_id: String(document.id),
      screen: 'RequiredDocuments',
    },
    label: 'document-requirement-approved',
  });
}

/** HR rejected the uploaded document. */
async function notifyDocumentRejected(companyId, document) {
  const branding = await fetchCompanyBranding(companyId);
  const employeeEmail =
    document.employee?.email ||
    (await fetchEmployeeAccountEmail(companyId, document.employee_id)) ||
    null;

  if (!employeeEmail) {
    console.error(`Document rejected email skipped: no email for employee ${document.employee_id}`);
  } else {
    const payload = buildRequirementEmailPayload(document, branding, {
      recipientName: getEmployeeFullName(document),
      hrComment: document.rejection_reason || null,
    });
    await sendEmailSafely(sendHrRequestRejectedEmail, employeeEmail, payload, 'rejected');
  }

  await pushNotification.sendNotificationToEmployee(companyId, document.employee_id, {
    title: 'Document Rejected',
    body: document.rejection_reason
      ? `Your document "${document.title || 'Document'}" was rejected: ${document.rejection_reason}`
      : `Your document "${document.title || 'Document'}" was rejected.`,
    data: {
      type: 'document_requirement_rejected',
      document_id: String(document.id),
      screen: 'RequiredDocuments',
    },
    label: 'document-requirement-rejected',
  });
}

/** Admin uploaded a document directly for one or more employees (no request/approval step). */
async function notifyCompanyDocumentUploaded(companyId, document, employeeIds) {
  const targetIds = Array.from(new Set((employeeIds || []).map(Number).filter(Boolean)));
  if (targetIds.length === 0) return;

  const branding = await fetchCompanyBranding(companyId);
  const summaryLines = buildDocumentSummaryLines(document);

  await Promise.all(
    targetIds.map(async (employeeId) => {
      const employeeEmail = await fetchEmployeeAccountEmail(companyId, employeeId);
      if (!employeeEmail) {
        console.error(`Company document upload email skipped: no email for employee ${employeeId}`);
      } else {
        const payload = {
          companyId: branding.companyId,
          companyName: branding.companyName,
          companyLogoUrl: branding.companyLogoUrl,
          recipientName: 'Team',
          employeeName: 'Team',
          requestTypeLabel: 'Document',
          hrComment: null,
          details: { summaryLines },
        };
        await sendEmailSafely(sendCompanyDocumentUploadedEmail, employeeEmail, payload, 'company-upload');
      }

      await pushNotification.sendNotificationToEmployee(companyId, employeeId, {
        title: 'New Document Uploaded',
        body: `A new document was uploaded for you: ${document.title || 'Document'}.`,
        data: {
          type: 'company_document_uploaded',
          document_id: String(document.id),
          screen: 'MyDocuments',
        },
        label: 'company-document-uploaded',
      });
    })
  );
}

module.exports = {
  notifyDocumentRequested,
  notifyDocumentUploaded,
  notifyDocumentApproved,
  notifyDocumentRejected,
  notifyCompanyDocumentUploaded,
};
