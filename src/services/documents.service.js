const pool = require('../db');
const { parseListPagination, buildListPaginationMeta } = require('./pagination.service');
const { toUtcIsoString, utcNowForPgTimestamp } = require('../utils/dateTime');
const { parsePositiveInt } = require('./documentAuth.service');
const documentRequirementNotification = require('./documentRequirementNotification.service');

function notifyDocumentEvent(action, ...args) {
  const notifiers = {
    requested: documentRequirementNotification.notifyDocumentRequested,
    uploaded: documentRequirementNotification.notifyDocumentUploaded,
    approved: documentRequirementNotification.notifyDocumentApproved,
    rejected: documentRequirementNotification.notifyDocumentRejected,
    company_upload: documentRequirementNotification.notifyCompanyDocumentUploaded,
  };
  const notifier = notifiers[action];
  if (!notifier) return;
  notifier(...args).catch((error) => {
    console.error(`Document ${action} notification error:`, error);
  });
}

const HR_DOC_STATUSES = new Set(['requested', 'uploaded', 'approved', 'rejected']);

const REQUIREMENT_SELECT = `hdr.id, hdr.company_id, hdr.employee_id, hdr.document_type, hdr.title, hdr.note,
  hdr.status, hdr.file_url, hdr.file_name, hdr.rejection_reason, hdr.requested_by, hdr.reviewed_by,
  hdr.reviewed_at, hdr.created_at, hdr.updated_at,
  e.employee_code, e.first_name AS employee_first_name, e.last_name AS employee_last_name,
  e.work_email AS employee_email, requester.email AS requested_by_email,
  reviewer.email AS reviewed_by_email`;

const REQUIREMENT_FROM = `FROM hr_document_requirements hdr
  INNER JOIN employees e ON e.id = hdr.employee_id AND e.company_id = hdr.company_id
  LEFT JOIN users requester ON requester.id = hdr.requested_by
  LEFT JOIN users reviewer ON reviewer.id = hdr.reviewed_by`;

function mapRequirementRow(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    employee_id: Number(row.employee_id),
    document_type: row.document_type,
    title: row.title,
    note: row.note,
    status: row.status,
    file_url: row.file_url,
    file_name: row.file_name,
    rejection_reason: row.rejection_reason,
    requested_by: Number(row.requested_by),
    reviewed_by: row.reviewed_by ? Number(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? toUtcIsoString(row.reviewed_at) : null,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
    employee: {
      id: Number(row.employee_id),
      employee_code: row.employee_code,
      first_name: row.employee_first_name,
      last_name: row.employee_last_name,
      email: row.employee_email,
    },
    requested_by_email: row.requested_by_email || null,
    reviewed_by_email: row.reviewed_by_email || null,
  };
}

async function fetchRequirementById(requirementId, companyId, { employeeId = null } = {}) {
  const values = [requirementId, companyId];
  let employeeFilter = '';
  if (employeeId) {
    values.push(employeeId);
    employeeFilter = ` AND hdr.employee_id = $${values.length}`;
  }
  const result = await pool.query(
    `SELECT ${REQUIREMENT_SELECT} ${REQUIREMENT_FROM}
     WHERE hdr.id = $1 AND hdr.company_id = $2${employeeFilter}`,
    values
  );
  if (!result.rows[0]) return null;
  return mapRequirementRow(result.rows[0]);
}

async function createHrDocumentRequest(companyId, hrUserId, body) {
  const employeeId = parsePositiveInt(body.employee_id);
  if (!employeeId) return { error: [400, 'employee_id must be a positive integer.'] };

  const documentType = String(body.document_type || '').trim();
  const title = String(body.title || body.document_type || '').trim();
  if (!documentType) return { error: [400, 'document_type is required.'] };
  if (!title) return { error: [400, 'title is required.'] };

  const note = body.note ? String(body.note).trim() : null;

  const employeeCheck = await pool.query(
    `SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND employment_status != 'exited'`,
    [employeeId, companyId]
  );
  if (employeeCheck.rowCount === 0) return { error: [404, 'Employee not found or inactive.'] };

  const result = await pool.query(
    `INSERT INTO hr_document_requirements
     (company_id, employee_id, document_type, title, note, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'requested', $6) RETURNING id`,
    [companyId, employeeId, documentType, title, note, hrUserId]
  );

  const document = await fetchRequirementById(Number(result.rows[0].id), companyId);
  notifyDocumentEvent('requested', companyId, document);
  return { document };
}

async function resolveBulkEmployeeIds(companyId, body, { scopeField = 'employee_scope' } = {}) {
  const scope = String(body[scopeField] || body.employee_scope || body.visibility || '')
    .trim()
    .toLowerCase();
  if (scope === 'all') {
    const result = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 AND employment_status != 'exited'`,
      [companyId]
    );
    const employeeIds = result.rows.map((row) => Number(row.id));
    if (employeeIds.length === 0) {
      return { error: [400, 'No active employees found for this company.'] };
    }
    return { employeeIds };
  }

  if (scope === 'selected') {
    const raw = body.employee_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: [400, 'employee_ids must be a non-empty array when selecting employees.'] };
    }
    const employeeIds = [...new Set(raw.map((id) => parsePositiveInt(id)).filter(Boolean))];
    if (employeeIds.length === 0) {
      return { error: [400, 'employee_ids must contain valid employee ids.'] };
    }
    const check = await pool.query(
      `SELECT id FROM employees
       WHERE company_id = $1 AND employment_status != 'exited' AND id = ANY($2::bigint[])`,
      [companyId, employeeIds]
    );
    if (check.rowCount !== employeeIds.length) {
      const foundIds = new Set(check.rows.map((row) => Number(row.id)));
      const missingIds = employeeIds.filter((id) => !foundIds.has(id));

      const existingRows = await pool.query(
        `SELECT id, company_id, employment_status
         FROM employees
         WHERE id = ANY($1::bigint[])`,
        [missingIds]
      );
      const existingById = new Map(existingRows.rows.map((row) => [Number(row.id), row]));

      const wrongCompanyIds = [];
      const exitedIds = [];
      const notFoundIds = [];

      for (const id of missingIds) {
        const row = existingById.get(id);
        if (!row) {
          notFoundIds.push(id);
          continue;
        }
        if (String(row.employment_status) === 'exited') {
          exitedIds.push(id);
          continue;
        }
        if (Number(row.company_id) !== Number(companyId)) {
          wrongCompanyIds.push(id);
        }
      }

      if (wrongCompanyIds.length > 0) {
        const sample = existingById.get(wrongCompanyIds[0]);
        return {
          error: [
            400,
            `Employee id(s) ${wrongCompanyIds.join(', ')} do not belong to your company (company_id ${companyId}). They belong to company_id ${sample?.company_id}. Use employee ids from your company only.`,
          ],
        };
      }
      if (exitedIds.length > 0) {
        return {
          error: [400, `Employee id(s) ${exitedIds.join(', ')} are exited and cannot receive document requests.`],
        };
      }
      if (notFoundIds.length > 0) {
        return {
          error: [400, `Employee id(s) ${notFoundIds.join(', ')} were not found. Use employees.id, not users.id.`],
        };
      }

      return { error: [400, 'One or more selected employees were not found or are inactive.'] };
    }
    return { employeeIds };
  }

  return { error: [400, `${scopeField} must be all or selected.`] };
}

async function createBulkHrDocumentRequests(companyId, hrUserId, body) {
  if (!companyId) {
    return {
      error: [
        400,
        'company_id is required for bulk document requests. Your HR account must be linked to a company.',
      ],
    };
  }
  const resolved = await resolveBulkEmployeeIds(companyId, body);
  if (resolved.error) return resolved;
  const { employeeIds } = resolved;

  const documentType = String(body.document_type || '').trim();
  const title = String(body.title || body.document_type || '').trim();
  if (!documentType) return { error: [400, 'document_type is required.'] };
  if (!title) return { error: [400, 'title is required.'] };

  const note = body.note ? String(body.note).trim() : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const createdIds = [];

    for (const employeeId of employeeIds) {
      const result = await client.query(
        `INSERT INTO hr_document_requirements
         (company_id, employee_id, document_type, title, note, status, requested_by)
         VALUES ($1, $2, $3, $4, $5, 'requested', $6) RETURNING id`,
        [companyId, employeeId, documentType, title, note, hrUserId]
      );
      createdIds.push(Number(result.rows[0].id));
    }

    await client.query('COMMIT');

    Promise.all(createdIds.map((id) => fetchRequirementById(id, companyId)))
      .then((documents) => {
        documents.filter(Boolean).forEach((document) => {
          notifyDocumentEvent('requested', companyId, document);
        });
      })
      .catch((error) => {
        console.error('Bulk document requested notification error:', error);
      });

    return { created_count: createdIds.length, document_ids: createdIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function mapCompanyDocumentRow(row) {
  const targetType = String(row.target_type || '').trim().toLowerCase();
  let visibility = 'all';
  let employeeIds = [];

  if (targetType === 'specific' && row.target_employee_id) {
    visibility = 'selected';
    employeeIds = [Number(row.target_employee_id)];
  } else if (targetType === 'multiple') {
    visibility = 'selected';
    employeeIds = Array.isArray(row.target_employee_ids)
      ? row.target_employee_ids.map((id) => Number(id))
      : row.target_employee_ids
        ? JSON.parse(JSON.stringify(row.target_employee_ids)).map((id) => Number(id))
        : [];
  }

  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    document_type: row.document_type,
    title: row.title,
    note: row.note,
    file_url: row.file_url,
    file_name: row.file_name,
    source: row.source,
    target_type: row.target_type,
    target_employee_id: row.target_employee_id ? Number(row.target_employee_id) : null,
    target_employee_ids: employeeIds,
    visibility,
    employee_ids: employeeIds,
    employee_count: employeeIds.length,
    status: row.status,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

async function createCompanyUploadedDocument(companyId, hrUserId, body) {
  const fileUrl = String(body.file_url || '').trim();
  const fileName = String(body.file_name || '').trim();
  if (!fileUrl) return { error: [400, 'file_url is required.'] };
  if (!fileName) return { error: [400, 'file_name is required.'] };

  const documentType = String(body.document_type || '').trim();
  const title = String(body.title || body.document_type || '').trim();
  if (!documentType) return { error: [400, 'document_type is required.'] };
  if (!title) return { error: [400, 'title is required.'] };

  const note = body.note ? String(body.note).trim() : null;
  const resolved = await resolveBulkEmployeeIds(companyId, body, { scopeField: 'visibility' });
  if (resolved.error) return resolved;

  const { employeeIds } = resolved;
  let targetType = 'all';
  let targetEmployeeId = null;
  let targetEmployeeIds = null;

  if (String(body.visibility || '').trim().toLowerCase() === 'selected') {
    if (employeeIds.length === 1) {
      targetType = 'specific';
      targetEmployeeId = employeeIds[0];
    } else {
      targetType = 'multiple';
      targetEmployeeIds = JSON.stringify(employeeIds);
    }
  }

  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `INSERT INTO documents
     (company_id, document_type, title, note, file_url, file_name, source, target_type,
      target_employee_id, target_employee_ids, uploaded_by, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'company_upload', $7, $8, $9, $10, 'active', $11, $11)
     RETURNING id, company_id, document_type, title, note, file_url, file_name, source, target_type,
       target_employee_id, target_employee_ids, status, created_at, updated_at`,
    [
      companyId,
      documentType,
      title,
      note,
      fileUrl,
      fileName,
      targetType,
      targetEmployeeId,
      targetEmployeeIds,
      hrUserId,
      now,
    ]
  );

  const document = mapCompanyDocumentRow(result.rows[0]);
  notifyDocumentEvent('company_upload', companyId, document, employeeIds);
  return { document };
}

async function listDocumentManagement(companyId, query = {}) {
  const scopedCompanyId = Number(companyId);
  if (!Number.isInteger(scopedCompanyId) || scopedCompanyId <= 0) {
    return { error: [403, 'Your account must be linked to a company to view employees.'] };
  }

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [scopedCompanyId];
  const conditions = ['e.company_id = $1', "e.employment_status != 'exited'"];

  const search = String(query.search || '').trim().toLowerCase();
  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(
      `(LOWER(e.first_name) LIKE $${idx} OR LOWER(e.last_name) LIKE $${idx} OR LOWER(e.work_email) LIKE $${idx} OR LOWER(e.employee_code) LIKE $${idx})`
    );
  }

  const employeeId = parsePositiveInt(query.employee_id);
  if (employeeId) {
    values.push(employeeId);
    conditions.push(`e.id = $${values.length}`);
  }

  const filter = String(query.filter || 'all').trim().toLowerCase();
  if (filter === 'missing') {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM hr_document_requirements hdr
      WHERE hdr.employee_id = e.id AND hdr.company_id = e.company_id
        AND hdr.status IN ('uploaded', 'approved')
    )`);
  } else if (filter === 'pending') {
    conditions.push(`EXISTS (
      SELECT 1 FROM hr_document_requirements hdr
      WHERE hdr.employee_id = e.id AND hdr.company_id = e.company_id
        AND hdr.status IN ('requested', 'rejected')
    )`);
  } else if (filter === 'uploaded') {
    conditions.push(`EXISTS (
      SELECT 1 FROM hr_document_requirements hdr
      WHERE hdr.employee_id = e.id AND hdr.company_id = e.company_id
        AND hdr.status = 'uploaded'
    )`);
  } else if (filter === 'approved') {
    conditions.push(`EXISTS (
      SELECT 1 FROM hr_document_requirements hdr
      WHERE hdr.employee_id = e.id AND hdr.company_id = e.company_id
        AND hdr.status = 'approved'
    )`);
  }

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM employees e WHERE ${whereSql}`,
    values
  );

  let listSql = `SELECT e.id, e.company_id, e.employee_code, e.first_name, e.last_name, e.work_email
    FROM employees e WHERE ${whereSql} ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC`;

  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  const employeeIds = listResult.rows.map((row) => Number(row.id));
  let requirementsByEmployee = {};

  if (employeeIds.length > 0) {
    const reqResult = await pool.query(
      `SELECT ${REQUIREMENT_SELECT} ${REQUIREMENT_FROM}
       WHERE hdr.company_id = $1 AND hdr.employee_id = ANY($2::bigint[])
       ORDER BY hdr.created_at DESC, hdr.id DESC`,
      [scopedCompanyId, employeeIds]
    );
    requirementsByEmployee = reqResult.rows.reduce((acc, row) => {
      const empId = Number(row.employee_id);
      if (!acc[empId]) acc[empId] = [];
      acc[empId].push(mapRequirementRow(row));
      return acc;
    }, {});
  }

  const employees = listResult.rows.map((row) => {
    const id = Number(row.id);
    const documents = requirementsByEmployee[id] || [];
    return {
      id,
      company_id: Number(row.company_id),
      employee_code: row.employee_code,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.work_email,
      documents,
      has_documents: documents.some((doc) => doc.status === 'uploaded' || doc.status === 'approved'),
      pending_count: documents.filter((doc) => doc.status === 'requested' || doc.status === 'rejected').length,
    };
  });

  return {
    company_id: scopedCompanyId,
    employees,
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function listEmployeeRequiredDocuments(employeeId, companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, employeeId];
  const conditions = ['hdr.company_id = $1', 'hdr.employee_id = $2'];

  const status = String(query.status || '').trim().toLowerCase();
  if (status) {
    if (!HR_DOC_STATUSES.has(status)) {
      return { error: [400, 'status must be one of: requested, uploaded, approved, rejected.'] };
    }
    values.push(status);
    conditions.push(`hdr.status = $${values.length}`);
  }

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM hr_document_requirements hdr WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT ${REQUIREMENT_SELECT} ${REQUIREMENT_FROM}
    WHERE ${whereSql} ORDER BY hdr.created_at DESC, hdr.id DESC`;

  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    documents: listResult.rows.map(mapRequirementRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function listEmployeeCompanyDocuments(employeeId, companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, employeeId];
  const conditions = [
    'd.company_id = $1',
    "d.source = 'company_upload'",
    "d.status = 'active'",
    `(
      d.target_type = 'all'
      OR (d.target_type = 'specific' AND d.target_employee_id = $2)
      OR (
        d.target_type = 'multiple'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(d.target_employee_ids, '[]'::jsonb)) AS elem
          WHERE elem::bigint = $2
        )
      )
    )`,
  ];

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM documents d WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT d.id, d.company_id, d.document_type, d.title, d.note, d.file_url, d.file_name,
      d.source, d.target_type, d.target_employee_id, d.target_employee_ids, d.status, d.created_at, d.updated_at
    FROM documents d
    WHERE ${whereSql}
    ORDER BY d.created_at DESC, d.id DESC`;

  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    documents: listResult.rows.map(mapCompanyDocumentRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function listCompanyUploadedDocuments(companyId, query = {}) {
  const scopedCompanyId = Number(companyId);
  if (!Number.isInteger(scopedCompanyId) || scopedCompanyId <= 0) {
    return { error: [403, 'Your account must be linked to a company to view documents.'] };
  }

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [scopedCompanyId];
  const conditions = ['d.company_id = $1', "d.source = 'company_upload'"];

  const search = String(query.search || '').trim().toLowerCase();
  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(
      `(LOWER(d.title) LIKE $${idx} OR LOWER(d.document_type) LIKE $${idx} OR LOWER(COALESCE(d.note, '')) LIKE $${idx} OR LOWER(COALESCE(d.file_name, '')) LIKE $${idx})`
    );
  }

  const whereSql = conditions.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM documents d WHERE ${whereSql}`,
    values
  );

  const listSql = `SELECT d.id, d.company_id, d.document_type, d.title, d.note, d.file_url, d.file_name,
      d.source, d.target_type, d.target_employee_id, d.target_employee_ids, d.status, d.created_at, d.updated_at
    FROM documents d
    WHERE ${whereSql}
    ORDER BY d.created_at DESC, d.id DESC`;

  const listResult = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    documents: listResult.rows.map(mapCompanyDocumentRow),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function uploadEmployeeDocument(requirementId, employeeId, companyId, body) {
  const fileUrl = String(body.file_url || '').trim();
  const fileName = String(body.file_name || '').trim();
  if (!fileUrl) return { error: [400, 'file_url is required.'] };
  if (!fileName) return { error: [400, 'file_name is required.'] };

  const existing = await pool.query(
    `SELECT id, status FROM hr_document_requirements
     WHERE id = $1 AND company_id = $2 AND employee_id = $3`,
    [requirementId, companyId, employeeId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document requirement not found.'] };

  const currentStatus = existing.rows[0].status;
  if (currentStatus === 'approved') {
    return { error: [400, 'This document is already accepted and cannot be changed.'] };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE hr_document_requirements SET status = 'uploaded', file_url = $1, file_name = $2,
     rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = $3
     WHERE id = $4 AND company_id = $5 AND employee_id = $6`,
    [fileUrl, fileName, now, requirementId, companyId, employeeId]
  );

  const document = await fetchRequirementById(requirementId, companyId, { employeeId });
  notifyDocumentEvent('uploaded', companyId, document);
  return { document };
}

async function approveDocument(requirementId, companyId, hrUserId) {
  const existing = await pool.query(
    'SELECT id, status FROM hr_document_requirements WHERE id = $1 AND company_id = $2',
    [requirementId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document requirement not found.'] };
  if (existing.rows[0].status !== 'uploaded') {
    return { error: [400, 'Only uploaded documents can be approved.'] };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE hr_document_requirements SET status = 'approved', reviewed_by = $1, reviewed_at = $2,
     updated_at = $2 WHERE id = $3 AND company_id = $4`,
    [hrUserId, now, requirementId, companyId]
  );

  const document = await fetchRequirementById(requirementId, companyId);
  notifyDocumentEvent('approved', companyId, document);
  return { document };
}

async function updateHrDocumentRequest(requirementId, companyId, body) {
  const existing = await pool.query(
    'SELECT id, status, document_type, title, note FROM hr_document_requirements WHERE id = $1 AND company_id = $2',
    [requirementId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document requirement not found.'] };

  const currentStatus = existing.rows[0].status;
  if (currentStatus !== 'requested' && currentStatus !== 'rejected') {
    return { error: [400, 'Only pending document requests can be updated.'] };
  }

  const documentType =
    body.document_type !== undefined
      ? String(body.document_type || '').trim()
      : existing.rows[0].document_type;
  const title =
    body.title !== undefined ? String(body.title || '').trim() : existing.rows[0].title;
  const note =
    body.note !== undefined ? (body.note ? String(body.note).trim() : null) : existing.rows[0].note;

  if (!documentType) return { error: [400, 'document_type is required.'] };
  if (!title) return { error: [400, 'title is required.'] };

  const now = utcNowForPgTimestamp();
  const resetRejected = currentStatus === 'rejected';

  await pool.query(
    `UPDATE hr_document_requirements
     SET document_type = $1, title = $2, note = $3, updated_at = $4
     ${resetRejected ? `, status = 'requested', file_url = NULL, file_name = NULL,
       rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL` : ''}
     WHERE id = $5 AND company_id = $6`,
    [documentType, title, note, now, requirementId, companyId]
  );

  const document = await fetchRequirementById(requirementId, companyId);
  if (resetRejected) {
    notifyDocumentEvent('requested', companyId, document);
  }
  return { document };
}

async function cancelHrDocumentRequest(requirementId, companyId) {
  const existing = await pool.query(
    'SELECT id, status FROM hr_document_requirements WHERE id = $1 AND company_id = $2',
    [requirementId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document requirement not found.'] };

  const currentStatus = existing.rows[0].status;
  if (currentStatus !== 'requested' && currentStatus !== 'rejected') {
    return { error: [400, 'Only pending document requests can be cancelled.'] };
  }

  await pool.query('DELETE FROM hr_document_requirements WHERE id = $1 AND company_id = $2', [
    requirementId,
    companyId,
  ]);

  return { id: requirementId };
}

async function rejectDocument(requirementId, companyId, hrUserId, body) {
  const rejectionReason = String(body.rejection_reason || '').trim();
  if (!rejectionReason) return { error: [400, 'rejection_reason is required.'] };

  const existing = await pool.query(
    'SELECT id, status FROM hr_document_requirements WHERE id = $1 AND company_id = $2',
    [requirementId, companyId]
  );
  if (!existing.rows[0]) return { error: [404, 'Document requirement not found.'] };
  if (existing.rows[0].status !== 'uploaded') {
    return { error: [400, 'Only uploaded documents can be rejected.'] };
  }

  const now = utcNowForPgTimestamp();
  await pool.query(
    `UPDATE hr_document_requirements SET status = 'rejected', rejection_reason = $1,
     reviewed_by = $2, reviewed_at = $3, updated_at = $3
     WHERE id = $4 AND company_id = $5`,
    [rejectionReason, hrUserId, now, requirementId, companyId]
  );

  const document = await fetchRequirementById(requirementId, companyId);
  notifyDocumentEvent('rejected', companyId, document);
  return { document };
}

module.exports = {
  parsePositiveInt,
  createHrDocumentRequest,
  createBulkHrDocumentRequests,
  createCompanyUploadedDocument,
  updateHrDocumentRequest,
  cancelHrDocumentRequest,
  listDocumentManagement,
  listEmployeeRequiredDocuments,
  listEmployeeCompanyDocuments,
  listCompanyUploadedDocuments,
  uploadEmployeeDocument,
  approveDocument,
  rejectDocument,
  fetchRequirementById,
};
