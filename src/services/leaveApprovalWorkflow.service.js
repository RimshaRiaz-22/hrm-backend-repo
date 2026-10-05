const pool = require('../db');
const { parsePositiveInt } = require('./leavePolicy.service');

const APPROVER_TYPES = new Set([
  'primary_manager',
  'additional_manager',
  'department_head',
  'access_role',
  'user',
]);
const MAX_STEPS = 10;

function mapApprovalStepRow(row) {
  return {
    id: Number(row.id),
    step_order: Number(row.step_order),
    approver_type: row.approver_type,
    access_role_id: row.access_role_id != null ? Number(row.access_role_id) : null,
    access_role_name: row.access_role_name || null,
    approver_user_id: row.approver_user_id != null ? Number(row.approver_user_id) : null,
    approver_user_name: row.approver_user_name || null,
    approver_user_email: row.approver_user_email || null,
  };
}

function describeStepRow(row) {
  switch (row.approver_type) {
    case 'primary_manager':
      return "Employee's Primary Manager";
    case 'additional_manager':
      return "Employee's Additional Manager";
    case 'department_head':
      return "Employee's Department Head";
    case 'access_role':
      return `Access Role: ${row.access_role_name || 'Unknown role'}`;
    case 'user':
      return row.approver_user_name || 'Specific approver';
    default:
      return 'Approver';
  }
}

async function validateStepsInput(companyId, stepsInput) {
  if (!Array.isArray(stepsInput)) return { error: 'steps must be an array.' };
  if (stepsInput.length > MAX_STEPS) return { error: `Maximum ${MAX_STEPS} approval steps.` };

  const steps = [];
  for (let i = 0; i < stepsInput.length; i += 1) {
    const raw = stepsInput[i] || {};
    const approverType = String(raw.approver_type || '').trim();
    if (!APPROVER_TYPES.has(approverType)) {
      return { error: `Step ${i + 1}: approver_type must be one of ${Array.from(APPROVER_TYPES).join(', ')}.` };
    }

    let accessRoleId = null;
    let approverUserId = null;

    if (approverType === 'access_role') {
      accessRoleId = parsePositiveInt(raw.access_role_id);
      if (!accessRoleId) return { error: `Step ${i + 1}: access_role_id is required for an access_role step.` };
      const check = await pool.query(`SELECT 1 FROM access_roles WHERE id = $1 AND company_id = $2`, [
        accessRoleId,
        companyId,
      ]);
      if (check.rowCount === 0) return { error: `Step ${i + 1}: access_role_id does not belong to your company.` };
    } else if (approverType === 'user') {
      approverUserId = parsePositiveInt(raw.approver_user_id);
      if (!approverUserId) return { error: `Step ${i + 1}: approver_user_id is required for a user step.` };
      const check = await pool.query(
        `SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [approverUserId, companyId]
      );
      if (check.rowCount === 0) {
        return { error: `Step ${i + 1}: approver_user_id does not belong to your company or is inactive.` };
      }
    }

    steps.push({
      step_order: i + 1,
      approver_type: approverType,
      access_role_id: accessRoleId,
      approver_user_id: approverUserId,
    });
  }

  return { steps };
}

const DYNAMIC_APPROVER_TYPES = new Set(['primary_manager', 'additional_manager', 'department_head']);
const MAX_PREVIEW_EMPLOYEES = 15;

/**
 * Resolves steps down to the actual person(s) they currently mean, so the config UI can show
 * real names/emails instead of just the generic type description:
 *  - access_role steps resolve unconditionally (company-wide, doesn't depend on requester).
 *  - primary/additional-manager and department-head steps only resolve when the policy is
 *    explicitly scoped to a small, named set of eligible employees — for department/
 *    designation-scoped or unrestricted policies there's no single concrete answer, since it
 *    varies per requester.
 * Mutates `steps` in place, adding `resolved_approvers` where resolvable.
 */
async function attachResolvedApprovers(policyId, companyId, steps) {
  // access_role steps don't depend on the requester — resolve them unconditionally to
  // every active user currently holding that role, company-wide.
  for (const step of steps) {
    if (step.approver_type !== 'access_role' || !step.access_role_id) continue;
    const users = await pool.query(
      `SELECT id, full_name, email FROM users
       WHERE company_id = $1 AND access_role_id = $2 AND is_active = true
       ORDER BY full_name`,
      [companyId, step.access_role_id]
    );
    if (users.rowCount === 0) continue;
    step.resolved_approvers = [
      {
        employee_id: null,
        employee_name: null,
        approvers: users.rows.map((u) => ({ user_id: Number(u.id), name: u.full_name, email: u.email })),
      },
    ];
  }

  if (!steps.some((step) => DYNAMIC_APPROVER_TYPES.has(step.approver_type))) return;

  const eligible = await pool.query(
    `SELECT el.employee_id, e.first_name, e.last_name
     FROM leave_policy_eligible_employees el
     JOIN employees e ON e.id = el.employee_id
     WHERE el.leave_policy_id = $1
     ORDER BY e.first_name, e.last_name
     LIMIT $2`,
    [policyId, MAX_PREVIEW_EMPLOYEES + 1]
  );
  if (eligible.rowCount === 0 || eligible.rowCount > MAX_PREVIEW_EMPLOYEES) return;

  for (const step of steps) {
    if (!DYNAMIC_APPROVER_TYPES.has(step.approver_type)) continue;

    const resolved = [];
    for (const emp of eligible.rows) {
      const approverUserIds = await resolveStepApproverUserIds(pool, companyId, emp.employee_id, step);
      if (approverUserIds.length === 0) continue;
      const users = await pool.query(
        `SELECT id, full_name, email FROM users WHERE id = ANY($1::bigint[])`,
        [approverUserIds]
      );
      resolved.push({
        employee_id: Number(emp.employee_id),
        employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        approvers: users.rows.map((u) => ({ user_id: Number(u.id), name: u.full_name, email: u.email })),
      });
    }
    if (resolved.length > 0) step.resolved_approvers = resolved;
  }
}

/** GET-style read of a leave policy's configured approval steps (empty = default flow). */
async function getPolicyApprovalSteps(policyId, companyId) {
  const policyCheck = await pool.query(`SELECT id FROM leave_policies WHERE id = $1 AND company_id = $2`, [
    policyId,
    companyId,
  ]);
  if (policyCheck.rowCount === 0) return { error: [404, 'Leave policy not found.'] };

  const result = await pool.query(
    `SELECT s.id, s.step_order, s.approver_type, s.access_role_id, s.approver_user_id,
            ar.name AS access_role_name,
            u.full_name AS approver_user_name, u.email AS approver_user_email
     FROM leave_policy_approval_steps s
     LEFT JOIN access_roles ar ON ar.id = s.access_role_id
     LEFT JOIN users u ON u.id = s.approver_user_id
     WHERE s.leave_policy_id = $1
     ORDER BY s.step_order ASC`,
    [policyId]
  );

  const steps = result.rows.map(mapApprovalStepRow);
  await attachResolvedApprovers(policyId, companyId, steps);

  return { approval_steps: steps };
}

/** Replace-all save for the config UI; step_order is derived from array position. */
async function replacePolicyApprovalSteps(policyId, companyId, stepsInput) {
  const policyCheck = await pool.query(`SELECT id FROM leave_policies WHERE id = $1 AND company_id = $2`, [
    policyId,
    companyId,
  ]);
  if (policyCheck.rowCount === 0) return { error: [404, 'Leave policy not found.'] };

  const validated = await validateStepsInput(companyId, stepsInput);
  if (validated.error) return { error: [400, validated.error] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM leave_policy_approval_steps WHERE leave_policy_id = $1`, [policyId]);

    if (validated.steps.length > 0) {
      const values = [];
      const placeholders = validated.steps
        .map((step, i) => {
          const base = i * 6;
          values.push(companyId, policyId, step.step_order, step.approver_type, step.access_role_id, step.approver_user_id);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        })
        .join(', ');
      await client.query(
        `INSERT INTO leave_policy_approval_steps
           (company_id, leave_policy_id, step_order, approver_type, access_role_id, approver_user_id)
         VALUES ${placeholders}`,
        values
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getPolicyApprovalSteps(policyId, companyId);
}

/** Copies the policy's current steps onto the request at submission time. No-op if none configured. */
async function snapshotApprovalStepsForRequest(client, leaveRequestId, policyId, companyId) {
  const steps = await client.query(
    `SELECT step_order, approver_type, access_role_id, approver_user_id
     FROM leave_policy_approval_steps
     WHERE leave_policy_id = $1
     ORDER BY step_order ASC`,
    [policyId]
  );
  if (steps.rowCount === 0) return;

  const values = [];
  const placeholders = steps.rows
    .map((step, i) => {
      const base = i * 6;
      values.push(
        companyId,
        leaveRequestId,
        step.step_order,
        step.approver_type,
        step.access_role_id,
        step.approver_user_id
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    })
    .join(', ');
  await client.query(
    `INSERT INTO leave_request_approvals
       (company_id, leave_request_id, step_order, approver_type, access_role_id, approver_user_id)
     VALUES ${placeholders}`,
    values
  );
}

async function requestHasApprovalSteps(db, leaveRequestId) {
  const result = await db.query(`SELECT 1 FROM leave_request_approvals WHERE leave_request_id = $1 LIMIT 1`, [
    leaveRequestId,
  ]);
  return result.rowCount > 0;
}

async function getCurrentPendingStep(db, leaveRequestId) {
  const result = await db.query(
    `SELECT id, step_order, approver_type, access_role_id, approver_user_id
     FROM leave_request_approvals
     WHERE leave_request_id = $1 AND status = 'pending'
     ORDER BY step_order ASC
     LIMIT 1`,
    [leaveRequestId]
  );
  return result.rows[0] || null;
}

async function getCurrentPendingStepWithDetails(db, leaveRequestId) {
  const result = await db.query(
    `SELECT lra.id, lra.step_order, lra.approver_type, lra.access_role_id, lra.approver_user_id,
            ar.name AS access_role_name,
            u.full_name AS approver_user_name
     FROM leave_request_approvals lra
     LEFT JOIN access_roles ar ON ar.id = lra.access_role_id
     LEFT JOIN users u ON u.id = lra.approver_user_id
     WHERE lra.leave_request_id = $1 AND lra.status = 'pending'
     ORDER BY lra.step_order ASC
     LIMIT 1`,
    [leaveRequestId]
  );
  return result.rows[0] || null;
}

/** Concrete users.id list allowed to act on this step right now, resolved against the requester. */
async function resolveStepApproverUserIds(db, companyId, employeeId, step) {
  if (step.approver_type === 'user') {
    return step.approver_user_id != null ? [Number(step.approver_user_id)] : [];
  }

  if (step.approver_type === 'access_role') {
    if (step.access_role_id == null) return [];
    const result = await db.query(
      `SELECT id FROM users WHERE company_id = $1 AND access_role_id = $2 AND is_active = true`,
      [companyId, step.access_role_id]
    );
    return result.rows.map((row) => Number(row.id));
  }

  if (step.approver_type === 'primary_manager' || step.approver_type === 'additional_manager') {
    const managerRole = step.approver_type === 'primary_manager' ? 'primary' : 'additional';
    const result = await db.query(
      `SELECT u.id
       FROM employee_line_managers elm
       INNER JOIN users u ON u.employee_id = elm.manager_id AND u.company_id = elm.company_id
       WHERE elm.company_id = $1 AND elm.employee_id = $2 AND elm.manager_role = $3 AND u.is_active = true`,
      [companyId, employeeId, managerRole]
    );
    return result.rows.map((row) => Number(row.id));
  }

  if (step.approver_type === 'department_head') {
    const result = await db.query(
      `SELECT u.id
       FROM employee_job_details ejd
       INNER JOIN department_line_managers dlm
         ON dlm.department_id = ejd.department_id AND dlm.company_id = ejd.company_id AND dlm.manager_role = 'head'
       INNER JOIN users u ON u.employee_id = dlm.employee_id AND u.company_id = dlm.company_id
       WHERE ejd.employee_id = $2 AND ejd.company_id = $1 AND u.is_active = true`,
      [companyId, employeeId]
    );
    return result.rows.map((row) => Number(row.id));
  }

  return [];
}

/** Lightweight progress summary attached to a leave request's API representation. Null = no workflow. */
async function getApprovalProgress(db, leaveRequestId) {
  const totalResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM leave_request_approvals WHERE leave_request_id = $1`,
    [leaveRequestId]
  );
  const total = totalResult.rows[0]?.total || 0;
  if (total === 0) return null;

  const current = await getCurrentPendingStepWithDetails(db, leaveRequestId);
  return {
    total_steps: total,
    current_step_order: current ? Number(current.step_order) : null,
    current_step_description: current ? describeStepRow(current) : null,
  };
}

/** Whether actingUserId can act on the request's current pending step right now. */
async function isUserActionableOnRequest(db, companyId, actingUserId, leaveRequestId, requesterEmployeeId) {
  const currentStep = await getCurrentPendingStep(db, leaveRequestId);
  if (!currentStep) return false;
  const eligibleUserIds = await resolveStepApproverUserIds(db, companyId, requesterEmployeeId, currentStep);
  return eligibleUserIds.includes(Number(actingUserId));
}

/**
 * Advances exactly one step. Must run inside the caller's transaction. Returns
 * { error } | { finalStatus: 'approved' | 'rejected' | null } — null means the chain
 * isn't finished yet (leave_requests.status should stay 'pending').
 */
async function actOnRequestStep(client, companyId, actingUserId, leaveRequestId, requesterEmployeeId, decision, comment, nowUtc) {
  const currentStep = await getCurrentPendingStep(client, leaveRequestId);
  if (!currentStep) {
    return { error: [400, 'This leave request has no pending approval step.'] };
  }

  const eligibleUserIds = await resolveStepApproverUserIds(client, companyId, requesterEmployeeId, currentStep);
  if (!eligibleUserIds.includes(Number(actingUserId))) {
    return { error: [404, 'Leave request not found.'] };
  }

  const stepStatus = decision === 'rejected' ? 'rejected' : 'approved';
  await client.query(
    `UPDATE leave_request_approvals
     SET status = $1, acted_by = $2, acted_at = $3::timestamp, comment = $4, updated_at = $3::timestamp
     WHERE id = $5`,
    [stepStatus, actingUserId, nowUtc, comment, currentStep.id]
  );

  if (stepStatus === 'rejected') {
    return { finalStatus: 'rejected' };
  }

  const remaining = await client.query(
    `SELECT 1 FROM leave_request_approvals WHERE leave_request_id = $1 AND status = 'pending' LIMIT 1`,
    [leaveRequestId]
  );
  return { finalStatus: remaining.rowCount === 0 ? 'approved' : null };
}

/** Company Admin override: marks any still-pending steps as skipped. Safe no-op with no workflow. */
async function skipPendingStepsForRequest(client, leaveRequestId, actingUserId, nowUtc, comment = null) {
  await client.query(
    `UPDATE leave_request_approvals
     SET status = 'skipped', acted_by = $1, acted_at = $2::timestamp, comment = COALESCE($3, comment), updated_at = $2::timestamp
     WHERE leave_request_id = $4 AND status = 'pending'`,
    [actingUserId, nowUtc, comment, leaveRequestId]
  );
}

module.exports = {
  getPolicyApprovalSteps,
  replacePolicyApprovalSteps,
  snapshotApprovalStepsForRequest,
  requestHasApprovalSteps,
  getCurrentPendingStep,
  resolveStepApproverUserIds,
  getApprovalProgress,
  isUserActionableOnRequest,
  actOnRequestStep,
  skipPendingStepsForRequest,
};
