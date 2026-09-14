const { parseListPagination, buildListPaginationMeta } = require('../pagination.service');
const {
  pool,
  parsePositiveInt,
  parseWeightage,
  assertWeightagesTotal100,
  validateEmployeesBelongToCompany,
  validateDepartmentBelongsToCompany,
  validateDesignationBelongsToCompany,
  getEmployeeGoalAssignments,
  ensureEmployeeCompetencyAssignments,
  utcNowForPgTimestamp,
  toUtcIsoString,
  parseOptionalDateInput,
} = require('./performance.helpers');

const CYCLE_TYPES = new Set(['monthly', 'semi_monthly', 'yearly', 'quarterly', 'custom']);
const CYCLE_STATUSES = new Set(['draft', 'active', 'closed']);

function mapCycle(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: row.name,
    cycle_type: row.cycle_type,
    start_date: row.start_date,
    end_date: row.end_date,
    rating_deadline: row.rating_deadline || null,
    goal_contribution: Number(row.goal_contribution),
    competency_contribution: Number(row.competency_contribution),
    status: row.status,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function mapParticipant(row) {
  let attachments = [];
  const rawAttachments = row.overall_remarks_attachments;
  if (Array.isArray(rawAttachments)) {
    attachments = rawAttachments;
  } else if (typeof rawAttachments === 'string' && rawAttachments.trim()) {
    try {
      const parsed = JSON.parse(rawAttachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      attachments = [];
    }
  }

  return {
    id: Number(row.id),
    cycle_id: Number(row.cycle_id),
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_email: row.employee_email || null,
    template_id: row.template_id != null ? Number(row.template_id) : null,
    status: row.status,
    goal_score: row.goal_score != null ? Number(row.goal_score) : null,
    competency_score: row.competency_score != null ? Number(row.competency_score) : null,
    calculated_rating: row.calculated_rating != null ? Number(row.calculated_rating) : null,
    final_rating: row.final_rating != null ? Number(row.final_rating) : null,
    rating_overridden: Boolean(row.rating_overridden),
    overall_remarks: row.overall_remarks || null,
    strengths: row.strengths || null,
    areas_for_improvement: row.areas_for_improvement || null,
    overall_remarks_attachments: attachments
      .map((item) => ({
        url: String(item?.url || '').trim(),
        name: String(item?.name || '').trim() || 'Attachment',
        mime_type: String(item?.mime_type || '').trim() || null,
      }))
      .filter((item) => item.url),
    submitted_at: toUtcIsoString(row.submitted_at),
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

function normalizeRemarksAttachments(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'overall_remarks_attachments must be an array.' };
  if (raw.length > 15) return { error: 'At most 15 overall remarks attachments are allowed.' };
  const attachments = [];
  for (const item of raw) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    if (url.length > 2000) return { error: 'Attachment URL is too long.' };
    attachments.push({
      url,
      name: String(item?.name || '').trim().slice(0, 200) || 'Attachment',
      mime_type: String(item?.mime_type || '').trim().slice(0, 120) || null,
    });
  }
  return attachments;
}

function employeeNameSql(alias = 'e') {
  return `NULLIF(TRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, ''))), '')`;
}

async function fetchCycle(companyId, id) {
  const cycleId = parsePositiveInt(id);
  if (!cycleId) return null;
  const result = await pool.query(
    `SELECT * FROM performance_appraisal_cycles WHERE id = $1 AND company_id = $2`,
    [cycleId, companyId]
  );
  return result.rows[0] || null;
}

function parseCycleFields(body = {}, existing = null) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) return { error: 'name is required.' };
  if (name.length > 200) return { error: 'name must be at most 200 characters.' };

  const cycleType = String(body.cycle_type ?? existing?.cycle_type ?? '')
    .trim()
    .toLowerCase();
  const normalizedCycleType =
    cycleType === 'annual'
      ? 'yearly'
      : cycleType === 'ad_hoc' || cycleType === 'adhoc'
        ? 'custom'
        : cycleType;
  if (!CYCLE_TYPES.has(normalizedCycleType)) {
    return { error: 'cycle_type must be one of: monthly, semi_monthly, yearly, quarterly, custom.' };
  }

  const startParsed = parseOptionalDateInput(body.start_date ?? existing?.start_date, 'start_date');
  if (startParsed.error) return { error: startParsed.error };
  if (!startParsed.value) return { error: 'start_date is required.' };

  const endParsed = parseOptionalDateInput(body.end_date ?? existing?.end_date, 'end_date');
  if (endParsed.error) return { error: endParsed.error };
  if (!endParsed.value) return { error: 'end_date is required.' };

  let ratingDeadline = null;
  if (
    body.rating_deadline !== undefined ||
    (existing && body.rating_deadline !== null && existing.rating_deadline)
  ) {
    if (body.rating_deadline === null || body.rating_deadline === '') {
      ratingDeadline = null;
    } else {
      const parsed = parseOptionalDateInput(
        body.rating_deadline ?? existing?.rating_deadline,
        'rating_deadline'
      );
      if (parsed.error) return { error: parsed.error };
      ratingDeadline = parsed.value;
    }
  }

  const goalContribution = Number(body.goal_contribution ?? existing?.goal_contribution);
  const competencyContribution = Number(
    body.competency_contribution ?? existing?.competency_contribution
  );
  if (!Number.isFinite(goalContribution) || goalContribution < 0 || goalContribution > 100) {
    return { error: 'goal_contribution must be between 0 and 100.' };
  }
  if (
    !Number.isFinite(competencyContribution) ||
    competencyContribution < 0 ||
    competencyContribution > 100
  ) {
    return { error: 'competency_contribution must be between 0 and 100.' };
  }
  if (Math.abs(goalContribution + competencyContribution - 100) > 0.01) {
    return { error: 'goal_contribution + competency_contribution must equal 100%.' };
  }

  let status = existing?.status || 'draft';
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    status = String(body.status).trim().toLowerCase();
    if (!CYCLE_STATUSES.has(status)) {
      return { error: 'status must be one of: draft, active, closed.' };
    }
  }

  return {
    name,
    cycle_type: normalizedCycleType,
    start_date: startParsed.value,
    end_date: endParsed.value,
    rating_deadline: ratingDeadline,
    goal_contribution: Math.round(goalContribution * 100) / 100,
    competency_contribution: Math.round(competencyContribution * 100) / 100,
    status,
  };
}

async function createCycle(companyId, body) {
  const fields = parseCycleFields(body);
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `INSERT INTO performance_appraisal_cycles
       (company_id, name, cycle_type, start_date, end_date, rating_deadline,
        goal_contribution, competency_contribution, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING *`,
    [
      companyId,
      fields.name,
      fields.cycle_type,
      fields.start_date,
      fields.end_date,
      fields.rating_deadline,
      fields.goal_contribution,
      fields.competency_contribution,
      fields.status,
      now,
    ]
  );
  return { cycle: mapCycle(result.rows[0]) };
}

async function getCycles(companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId];
  const filters = ['company_id = $1'];
  let idx = 2;

  if (query.status) {
    const status = String(query.status).trim().toLowerCase();
    if (!CYCLE_STATUSES.has(status)) return { error: [400, 'Invalid status filter.'] };
    filters.push(`status = $${idx++}`);
    values.push(status);
  }

  const search = String(query.search || '').trim();
  if (search) {
    filters.push(`name ILIKE $${idx}`);
    values.push(`%${search}%`);
    idx += 1;
  }

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM performance_appraisal_cycles WHERE ${whereSql}`,
    values
  );
  const listSql = `SELECT * FROM performance_appraisal_cycles WHERE ${whereSql} ORDER BY created_at DESC, id DESC`;
  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    cycles: result.rows.map(mapCycle),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getCycleById(companyId, id) {
  const row = await fetchCycle(companyId, id);
  if (!row) return { error: [404, 'Appraisal cycle not found.'] };
  return { cycle: mapCycle(row) };
}

async function updateCycle(companyId, id, body) {
  const row = await fetchCycle(companyId, id);
  if (!row) return { error: [404, 'Appraisal cycle not found.'] };
  if (row.status === 'closed') return { error: [400, 'This appraisal cycle is closed and cannot be edited.'] };
  const fields = parseCycleFields(body, mapCycle(row));
  if (fields.error) return { error: [400, fields.error] };
  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `UPDATE performance_appraisal_cycles
     SET name = $1, cycle_type = $2, start_date = $3, end_date = $4, rating_deadline = $5,
         goal_contribution = $6, competency_contribution = $7, status = $8, updated_at = $9
     WHERE id = $10 AND company_id = $11
     RETURNING *`,
    [
      fields.name,
      fields.cycle_type,
      fields.start_date,
      fields.end_date,
      fields.rating_deadline,
      fields.goal_contribution,
      fields.competency_contribution,
      fields.status,
      now,
      row.id,
      companyId,
    ]
  );
  return { cycle: mapCycle(result.rows[0]) };
}

async function deleteCycle(companyId, id) {
  const row = await fetchCycle(companyId, id);
  if (!row) return { error: [404, 'Appraisal cycle not found.'] };
  if (row.status === 'closed') return { error: [400, 'This appraisal cycle is closed and cannot be deleted.'] };
  await pool.query(`DELETE FROM performance_appraisal_cycles WHERE id = $1 AND company_id = $2`, [
    row.id,
    companyId,
  ]);
  return { deleted: true, id: Number(row.id) };
}

async function resolveParticipantEmployeeIds(companyId, body = {}) {
  const employeeIds = new Set();

  if (Array.isArray(body.employee_ids)) {
    for (const raw of body.employee_ids) {
      const id = parsePositiveInt(raw);
      if (!id) return { error: 'employee_ids must contain positive integers.' };
      employeeIds.add(id);
    }
  }
  if (body.employee_id) {
    const id = parsePositiveInt(body.employee_id);
    if (!id) return { error: 'employee_id must be a positive integer.' };
    employeeIds.add(id);
  }

  let departmentId = null;
  let designationId = null;
  let companyWide = body.company === true || body.company === 'true' || body.scope_type === 'company';

  if (body.department_id) {
    departmentId = parsePositiveInt(body.department_id);
    if (!departmentId) return { error: 'department_id must be a positive integer.' };
    if (!(await validateDepartmentBelongsToCompany(companyId, departmentId))) {
      return { error: 'department_id does not belong to your company.' };
    }
  }
  if (body.designation_id) {
    designationId = parsePositiveInt(body.designation_id);
    if (!designationId) return { error: 'designation_id must be a positive integer.' };
    if (!(await validateDesignationBelongsToCompany(companyId, designationId))) {
      return { error: 'designation_id does not belong to your company.' };
    }
  }

  if (companyWide || departmentId || designationId) {
    const result = await pool.query(
      `SELECT e.id
       FROM employees e
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       WHERE e.company_id = $1
         AND ($2::boolean = true OR (
           ($3::bigint IS NULL OR ejd.department_id = $3::bigint)
           AND ($4::bigint IS NULL OR ejd.designation_id = $4::bigint)
         ))`,
      [companyId, companyWide, departmentId, designationId]
    );
    result.rows.forEach((r) => employeeIds.add(Number(r.id)));
  }

  const ids = Array.from(employeeIds);
  if (!ids.length) return { error: 'Select at least one participant.' };
  const check = await validateEmployeesBelongToCompany(companyId, ids);
  if (check.error) return { error: check.error };
  return { employeeIds: ids };
}

async function getEmployeeErrorLabel(db, companyId, employeeId) {
  const result = await db.query(
    `SELECT work_email,
            NULLIF(TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))), '') AS employee_name
     FROM employees
     WHERE id = $1 AND company_id = $2`,
    [employeeId, companyId]
  );
  if (result.rowCount === 0) return `Employee #${employeeId}`;
  const row = result.rows[0];
  if (row.work_email) return row.work_email;
  if (row.employee_name) return row.employee_name;
  return `Employee #${employeeId}`;
}

async function snapshotParticipant(client, companyId, cycleId, employeeId, competencyOverrides = null) {
  const employeeLabel = await getEmployeeErrorLabel(client, companyId, employeeId);
  const goals = await getEmployeeGoalAssignments(client, companyId, employeeId);
  if (!goals.length) {
    return { error: `${employeeLabel} has no assigned goals.` };
  }
  const goalCheck = assertWeightagesTotal100(goals, 'weightage', `${employeeLabel} goal weightages`);
  if (goalCheck.error) return { error: goalCheck.error };

  const competencies = await ensureEmployeeCompetencyAssignments(client, companyId, employeeId);
  if (!competencies.length) {
    return { error: `${employeeLabel} has no assigned competencies.` };
  }

  const overrideMap = new Map();
  if (Array.isArray(competencyOverrides)) {
    for (const item of competencyOverrides) {
      const competencyId = parsePositiveInt(item.competency_id);
      const weight = parseWeightage(item.weightage, 'weightage');
      if (!competencyId) return { error: `Invalid competency_id for ${employeeLabel}.` };
      if (weight.error) return { error: weight.error };
      overrideMap.set(competencyId, weight.value);
    }
  }

  const competencyItems = competencies.map((item) => ({
    competency_id: item.competency_id,
    name: item.name,
    description: item.description,
    weightage: overrideMap.has(item.competency_id)
      ? overrideMap.get(item.competency_id)
      : item.weightage,
  }));

  const unknownOverride = [...overrideMap.keys()].find(
    (id) => !competencies.some((item) => item.competency_id === id)
  );
  if (unknownOverride) {
    return { error: `Competency ${unknownOverride} is not assigned to ${employeeLabel}.` };
  }

  const compCheck = assertWeightagesTotal100(
    competencyItems,
    'weightage',
    `${employeeLabel} competency weightages`
  );
  if (compCheck.error) return { error: compCheck.error };

  const now = utcNowForPgTimestamp();
  const participantResult = await client.query(
    `INSERT INTO performance_appraisal_participants
       (company_id, cycle_id, employee_id, template_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, $5)
     ON CONFLICT (cycle_id, employee_id) DO NOTHING
     RETURNING *`,
    [companyId, cycleId, employeeId, null, now]
  );

  let participant = participantResult.rows[0];
  if (!participant) {
    const existing = await client.query(
      `SELECT * FROM performance_appraisal_participants
       WHERE cycle_id = $1 AND employee_id = $2 AND company_id = $3`,
      [cycleId, employeeId, companyId]
    );
    participant = existing.rows[0];
    if (participant.status === 'submitted') {
      return { error: `${employeeLabel} appraisal is already submitted.` };
    }
    await client.query(
      `DELETE FROM performance_appraisal_goal_ratings WHERE participant_id = $1`,
      [participant.id]
    );
    await client.query(
      `DELETE FROM performance_appraisal_competency_ratings WHERE participant_id = $1`,
      [participant.id]
    );
    await client.query(
      `UPDATE performance_appraisal_participants
       SET template_id = $1, status = 'pending', goal_score = NULL, competency_score = NULL,
           calculated_rating = NULL, final_rating = NULL, rating_overridden = FALSE,
           overall_remarks = NULL, strengths = NULL, areas_for_improvement = NULL,
           overall_remarks_attachments = '[]'::jsonb,
           submitted_at = NULL, submitted_by = NULL, updated_at = $2
       WHERE id = $3`,
      [null, now, participant.id]
    );
  }

  for (const goal of goals) {
    await client.query(
      `INSERT INTO performance_appraisal_goal_ratings
         (company_id, participant_id, goal_id, goal_title, goal_description, weightage, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [companyId, participant.id, goal.goal_id, goal.title, goal.description, goal.weightage, now]
    );
  }

  for (const item of competencyItems) {
    await client.query(
      `INSERT INTO performance_appraisal_competency_ratings
         (company_id, participant_id, competency_id, competency_name, competency_description,
          default_weightage, weightage, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        companyId,
        participant.id,
        item.competency_id,
        item.name,
        item.description,
        item.weightage,
        item.weightage,
        now,
      ]
    );
  }

  return { participant_id: Number(participant.id), employee_id: employeeId };
}

async function previewParticipant(companyId, employeeId) {
  const id = parsePositiveInt(employeeId);
  if (!id) return { error: [400, 'Invalid employee id.'] };

  const employeeResult = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.work_email
     FROM employees e
     WHERE e.id = $1 AND e.company_id = $2`,
    [id, companyId]
  );
  if (employeeResult.rowCount === 0) return { error: [404, 'Employee not found.'] };
  const employee = employeeResult.rows[0];
  const employeeName =
    `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || `Employee #${id}`;

  const goals = await getEmployeeGoalAssignments(pool, companyId, id);
  const competencies = await ensureEmployeeCompetencyAssignments(pool, companyId, id);
  const competenciesTotal =
    Math.round(competencies.reduce((sum, item) => sum + Number(item.weightage || 0), 0) * 100) / 100;

  return {
    employee: {
      id,
      name: employeeName,
      email: employee.work_email || null,
    },
    goals,
    goals_total: Math.round(goals.reduce((sum, goal) => sum + Number(goal.weightage || 0), 0) * 100) / 100,
    competencies,
    competencies_total: competenciesTotal,
    // Keep template null — competencies are assigned like goals now.
    template: null,
    ready: Boolean(goals.length && competencies.length),
    errors: [
      !goals.length ? 'No assigned goals found for this employee.' : null,
      !competencies.length ? 'No assigned competencies found for this employee.' : null,
    ].filter(Boolean),
  };
}

async function addParticipants(companyId, cycleId, body = {}) {
  const cycle = await fetchCycle(companyId, cycleId);
  if (!cycle) return { error: [404, 'Appraisal cycle not found.'] };
  if (cycle.status === 'closed') return { error: [400, 'This appraisal cycle is closed. Participants cannot be added.'] };

  const resolved = await resolveParticipantEmployeeIds(companyId, body);
  if (resolved.error) return { error: [400, resolved.error] };

  const overridesByEmployee = new Map();
  if (Array.isArray(body.overrides)) {
    for (const entry of body.overrides) {
      const employeeId = parsePositiveInt(entry.employee_id);
      if (!employeeId) return { error: [400, 'Each override requires a valid employee_id.'] };
      overridesByEmployee.set(employeeId, Array.isArray(entry.competencies) ? entry.competencies : []);
    }
  } else if (body.overrides && typeof body.overrides === 'object') {
    for (const [rawId, competencies] of Object.entries(body.overrides)) {
      const employeeId = parsePositiveInt(rawId);
      if (!employeeId) return { error: [400, 'Invalid employee id in overrides.'] };
      overridesByEmployee.set(employeeId, Array.isArray(competencies) ? competencies : []);
    }
  }

  const client = await pool.connect();
  const added = [];
  try {
    await client.query('BEGIN');
    for (const employeeId of resolved.employeeIds) {
      const snap = await snapshotParticipant(
        client,
        companyId,
        cycle.id,
        employeeId,
        overridesByEmployee.get(employeeId) || null
      );
      if (snap.error) {
        await client.query('ROLLBACK');
        return { error: [400, snap.error] };
      }
      added.push(snap);
    }
    if (cycle.status === 'draft') {
      await client.query(
        `UPDATE performance_appraisal_cycles SET status = 'active', updated_at = $1
         WHERE id = $2 AND company_id = $3`,
        [utcNowForPgTimestamp(), cycle.id, companyId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { participants: added };
}

async function listParticipants(companyId, cycleId, query = {}) {
  const cycle = await fetchCycle(companyId, cycleId);
  if (!cycle) return { error: [404, 'Appraisal cycle not found.'] };

  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, cycle.id];
  const filters = ['p.company_id = $1', 'p.cycle_id = $2'];
  let idx = 3;
  const search = String(query.search || '').trim();
  if (search) {
    filters.push(`(${employeeNameSql('e')} ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx += 1;
  }

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM performance_appraisal_participants p
     JOIN employees e ON e.id = p.employee_id
     WHERE ${whereSql}`,
    values
  );

  const listSql = `
    SELECT p.*, ${employeeNameSql('e')} AS employee_name, e.work_email AS employee_email
    FROM performance_appraisal_participants p
    JOIN employees e ON e.id = p.employee_id
    WHERE ${whereSql}
    ORDER BY p.id ASC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    cycle: mapCycle(cycle),
    participants: result.rows.map(mapParticipant),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getParticipantDetail(companyId, cycleId, participantId) {
  const cycle = await fetchCycle(companyId, cycleId);
  if (!cycle) return { error: [404, 'Appraisal cycle not found.'] };
  const pid = parsePositiveInt(participantId);
  if (!pid) return { error: [400, 'Invalid participant id.'] };

  const result = await pool.query(
    `SELECT p.*, ${employeeNameSql('e')} AS employee_name, e.work_email AS employee_email
     FROM performance_appraisal_participants p
     JOIN employees e ON e.id = p.employee_id
     WHERE p.id = $1 AND p.cycle_id = $2 AND p.company_id = $3`,
    [pid, cycle.id, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'Participant not found.'] };

  const row = result.rows[0];
  const goals = await pool.query(
    `SELECT * FROM performance_appraisal_goal_ratings WHERE participant_id = $1 ORDER BY id ASC`,
    [pid]
  );
  const competencies = await pool.query(
    `SELECT * FROM performance_appraisal_competency_ratings WHERE participant_id = $1 ORDER BY id ASC`,
    [pid]
  );

  return {
    cycle: mapCycle(cycle),
    participant: mapParticipant(row),
    goals: goals.rows.map((goalRow) => ({
      id: Number(goalRow.id),
      goal_id: goalRow.goal_id != null ? Number(goalRow.goal_id) : null,
      goal_title: goalRow.goal_title,
      goal_description: goalRow.goal_description,
      weightage: Number(goalRow.weightage),
      rating: goalRow.rating != null ? Number(goalRow.rating) : null,
      achievement_status: goalRow.achievement_status,
      remarks: goalRow.remarks,
    })),
    competencies: competencies.rows.map((compRow) => ({
      id: Number(compRow.id),
      competency_id: compRow.competency_id != null ? Number(compRow.competency_id) : null,
      competency_name: compRow.competency_name,
      competency_description: compRow.competency_description,
      default_weightage: Number(compRow.default_weightage),
      weightage: Number(compRow.weightage),
      rating: compRow.rating != null ? Number(compRow.rating) : null,
      remarks: compRow.remarks,
    })),
  };
}

function weightedScore(items) {
  let score = 0;
  for (const item of items) {
    score += (Number(item.rating) * Number(item.weightage)) / 100;
  }
  return Math.round(score * 10000) / 10000;
}

async function overrideCompetencyWeights(companyId, cycleId, participantId, body = {}) {
  const detail = await getParticipantDetail(companyId, cycleId, participantId);
  if (detail.error) return detail;
  if (detail.participant.status === 'submitted' || 
      ['pip_suggested', 'pip_created', 'pip_dismissed'].includes(detail.participant.status)) {
    return { error: [400, 'Competency weightages cannot be changed after the appraisal is submitted.'] };
  }
  if (detail.cycle.status === 'closed') {
    return { error: [400, 'This appraisal cycle is closed.'] };
  }

  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return { error: [400, 'items must be an array.'] };

  const parsed = [];
  for (const item of items) {
    const id = parsePositiveInt(item.id);
    if (!id) return { error: [400, 'Each item requires a valid id.'] };
    const weight = parseWeightage(item.weightage);
    if (weight.error) return { error: [400, weight.error] };
    parsed.push({ id, weightage: weight.value });
  }

  const totalCheck = assertWeightagesTotal100(parsed, 'weightage', 'Employee competency weightages');
  if (totalCheck.error) return { error: [400, totalCheck.error] };

  const existingIds = new Set(detail.competencies.map((c) => c.id));
  for (const item of parsed) {
    if (!existingIds.has(item.id)) {
      return { error: [400, `Competency rating id ${item.id} is invalid for this participant.`] };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = utcNowForPgTimestamp();
    for (const item of parsed) {
      await client.query(
        `UPDATE performance_appraisal_competency_ratings
         SET weightage = $1, updated_at = $2
         WHERE id = $3 AND participant_id = $4 AND company_id = $5`,
        [item.weightage, now, item.id, detail.participant.id, companyId]
      );
    }
    await client.query(
      `UPDATE performance_appraisal_participants SET status = 'in_progress', updated_at = $1 WHERE id = $2`,
      [now, detail.participant.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getParticipantDetail(companyId, cycleId, participantId);
}

async function saveRatings(companyId, cycleId, participantId, body = {}, userId) {
  const detail = await getParticipantDetail(companyId, cycleId, participantId);
  if (detail.error) return detail;
  const lockedStatuses = new Set(['submitted', 'pip_suggested', 'pip_created', 'pip_dismissed']);
  if (lockedStatuses.has(detail.participant.status)) {
    return { error: [400, 'This appraisal is locked. Reopen it before editing ratings.'] };
  }
  if (detail.cycle.status === 'closed') {
    return { error: [400, 'This appraisal cycle is closed. Ratings cannot be edited.'] };
  }

  const goalRatings = Array.isArray(body.goals) ? body.goals : [];
  const competencyRatings = Array.isArray(body.competencies) ? body.competencies : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = utcNowForPgTimestamp();

    for (const item of goalRatings) {
      const id = parsePositiveInt(item.id);
      if (!id) {
        await client.query('ROLLBACK');
        return { error: [400, 'Each goal rating requires a valid id.'] };
      }
      const rating = Number(item.rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        await client.query('ROLLBACK');
        return { error: [400, 'Goal rating must be between 1 and 5.'] };
      }
      await client.query(
        `UPDATE performance_appraisal_goal_ratings
         SET rating = $1, achievement_status = $2, remarks = $3, updated_at = $4
         WHERE id = $5 AND participant_id = $6 AND company_id = $7`,
        [
          rating,
          item.achievement_status != null ? String(item.achievement_status).trim() || null : null,
          item.remarks != null ? String(item.remarks).trim() || null : null,
          now,
          id,
          detail.participant.id,
          companyId,
        ]
      );
    }

    for (const item of competencyRatings) {
      const id = parsePositiveInt(item.id);
      if (!id) {
        await client.query('ROLLBACK');
        return { error: [400, 'Each competency rating requires a valid id.'] };
      }
      const rating = Number(item.rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        await client.query('ROLLBACK');
        return { error: [400, 'Competency rating must be between 1 and 5.'] };
      }
      await client.query(
        `UPDATE performance_appraisal_competency_ratings
         SET rating = $1, remarks = $2, updated_at = $3
         WHERE id = $4 AND participant_id = $5 AND company_id = $6`,
        [
          rating,
          item.remarks != null ? String(item.remarks).trim() || null : null,
          now,
          id,
          detail.participant.id,
          companyId,
        ]
      );
    }

    const normalizedAttachments = normalizeRemarksAttachments(body.overall_remarks_attachments);
    if (normalizedAttachments?.error) {
      await client.query('ROLLBACK');
      return { error: [400, normalizedAttachments.error] };
    }
    const attachmentsJson =
      normalizedAttachments === undefined ? null : JSON.stringify(normalizedAttachments);

    await client.query(
      `UPDATE performance_appraisal_participants
       SET overall_remarks = COALESCE($1, overall_remarks),
           strengths = COALESCE($2, strengths),
           areas_for_improvement = COALESCE($3, areas_for_improvement),
           overall_remarks_attachments = COALESCE($4::jsonb, overall_remarks_attachments),
           status = 'in_progress',
           updated_at = $5
       WHERE id = $6`,
      [
        body.overall_remarks != null ? String(body.overall_remarks).trim() || null : null,
        body.strengths != null ? String(body.strengths).trim() || null : null,
        body.areas_for_improvement != null
          ? String(body.areas_for_improvement).trim() || null
          : null,
        attachmentsJson,
        now,
        detail.participant.id,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Recalculate preview scores
  const refreshed = await getParticipantDetail(companyId, cycleId, participantId);
  if (refreshed.error) return refreshed;

  const goalsComplete = refreshed.goals.every((g) => g.rating != null);
  const compsComplete = refreshed.competencies.every((c) => c.rating != null);
  let goalScore = null;
  let competencyScore = null;
  let calculated = null;
  if (goalsComplete) goalScore = weightedScore(refreshed.goals);
  if (compsComplete) competencyScore = weightedScore(refreshed.competencies);
  if (goalScore != null && competencyScore != null) {
    calculated =
      Math.round(
        (goalScore * (refreshed.cycle.goal_contribution / 100) +
          competencyScore * (refreshed.cycle.competency_contribution / 100)) *
          10000
      ) / 10000;
  }

  if (goalScore != null || competencyScore != null) {
    await pool.query(
      `UPDATE performance_appraisal_participants
       SET goal_score = $1, competency_score = $2, calculated_rating = $3, updated_at = $4
       WHERE id = $5`,
      [goalScore, competencyScore, calculated, utcNowForPgTimestamp(), refreshed.participant.id]
    );
  }

  return getParticipantDetail(companyId, cycleId, participantId);
}

async function submitAppraisal(companyId, cycleId, participantId, body = {}, userId) {
  const saved = await saveRatings(companyId, cycleId, participantId, body, userId);
  if (saved.error) return saved;

  if (saved.goals.some((g) => g.rating == null)) {
    return { error: [400, 'Please rate all goals before submitting.'] };
  }
  if (saved.competencies.some((c) => c.rating == null)) {
    return { error: [400, 'Please rate all competencies before submitting.'] };
  }

  const goalScore = weightedScore(saved.goals);
  const competencyScore = weightedScore(saved.competencies);
  const calculated =
    Math.round(
      (goalScore * (saved.cycle.goal_contribution / 100) +
        competencyScore * (saved.cycle.competency_contribution / 100)) *
        10000
    ) / 10000;

  let finalRating = calculated;
  let overridden = false;
  // Manual final-rating override disabled — final always equals calculated.

  const submitAttachments = normalizeRemarksAttachments(body.overall_remarks_attachments);
  if (submitAttachments?.error) {
    return { error: [400, submitAttachments.error] };
  }

  const now = utcNowForPgTimestamp();
  let status = 'submitted';
  if (finalRating <= 2) status = 'pip_suggested';

  await pool.query(
    `UPDATE performance_appraisal_participants
     SET goal_score = $1, competency_score = $2, calculated_rating = $3, final_rating = $4,
         rating_overridden = $5, status = $6, submitted_at = $7, submitted_by = $8,
         overall_remarks = COALESCE($9, overall_remarks),
         strengths = COALESCE($10, strengths),
         areas_for_improvement = COALESCE($11, areas_for_improvement),
         overall_remarks_attachments = COALESCE($12::jsonb, overall_remarks_attachments),
         updated_at = $7
     WHERE id = $13 AND company_id = $14`,
    [
      goalScore,
      competencyScore,
      calculated,
      finalRating,
      overridden,
      status,
      now,
      userId || null,
      body.overall_remarks != null ? String(body.overall_remarks).trim() || null : null,
      body.strengths != null ? String(body.strengths).trim() || null : null,
      body.areas_for_improvement != null
        ? String(body.areas_for_improvement).trim() || null
        : null,
      submitAttachments === undefined ? null : JSON.stringify(submitAttachments),
      saved.participant.id,
      companyId,
    ]
  );

  return getParticipantDetail(companyId, cycleId, participantId);
}

async function getSummary(companyId, cycleId, participantId) {
  const detail = await getParticipantDetail(companyId, cycleId, participantId);
  if (detail.error) return detail;
  if (!['submitted', 'pip_suggested', 'pip_created', 'pip_dismissed'].includes(detail.participant.status)) {
    return { error: [400, 'Performance summary is available after the appraisal is submitted.'] };
  }
  return {
    summary: {
      employee: {
        id: detail.participant.employee_id,
        name: detail.participant.employee_name,
      },
      cycle: detail.cycle,
      final_rating: detail.participant.final_rating,
      calculated_rating: detail.participant.calculated_rating,
      rating_overridden: detail.participant.rating_overridden,
      goal_score: detail.participant.goal_score,
      competency_score: detail.participant.competency_score,
      goals: detail.goals,
      competencies: detail.competencies,
      overall_remarks: detail.participant.overall_remarks,
      strengths: detail.participant.strengths,
      areas_for_improvement: detail.participant.areas_for_improvement,
      overall_remarks_attachments: detail.participant.overall_remarks_attachments,
      status: detail.participant.status,
      submitted_at: detail.participant.submitted_at,
    },
  };
}

async function getMySummaries(companyId, employeeId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, employeeId];
  const whereSql = `p.company_id = $1 AND p.employee_id = $2
    AND p.status IN ('submitted', 'pip_suggested', 'pip_created', 'pip_dismissed')`;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM performance_appraisal_participants p WHERE ${whereSql}`,
    values
  );
  const listSql = `
    SELECT p.*, c.name AS cycle_name, c.cycle_type, c.start_date, c.end_date
    FROM performance_appraisal_participants p
    JOIN performance_appraisal_cycles c ON c.id = p.cycle_id
    WHERE ${whereSql}
    ORDER BY p.submitted_at DESC NULLS LAST, p.id DESC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $3 OFFSET $4`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    summaries: result.rows.map((row) => ({
      participant_id: Number(row.id),
      cycle_id: Number(row.cycle_id),
      cycle_name: row.cycle_name,
      cycle_type: row.cycle_type,
      start_date: row.start_date,
      end_date: row.end_date,
      final_rating: row.final_rating != null ? Number(row.final_rating) : null,
      goal_score: row.goal_score != null ? Number(row.goal_score) : null,
      competency_score: row.competency_score != null ? Number(row.competency_score) : null,
      calculated_rating: row.calculated_rating != null ? Number(row.calculated_rating) : null,
      rating_overridden: Boolean(row.rating_overridden),
      status: row.status,
      submitted_at: toUtcIsoString(row.submitted_at),
      overall_remarks: row.overall_remarks,
      strengths: row.strengths,
      areas_for_improvement: row.areas_for_improvement,
      overall_remarks_attachments: row.overall_remarks_attachments || [],
    })),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getMySummaryItems(companyId, employeeId) {
  const whereSql = `p.company_id = $1 AND p.employee_id = $2
    AND p.status IN ('submitted', 'pip_suggested', 'pip_created', 'pip_dismissed')`;
  const values = [companyId, employeeId];

  const goals = await pool.query(
    `SELECT gr.id, gr.goal_title, gr.weightage, gr.rating, gr.achievement_status, gr.remarks,
            p.cycle_id, c.name AS cycle_name
     FROM performance_appraisal_goal_ratings gr
     JOIN performance_appraisal_participants p ON p.id = gr.participant_id
     JOIN performance_appraisal_cycles c ON c.id = p.cycle_id
     WHERE ${whereSql} AND gr.rating IS NOT NULL
     ORDER BY p.submitted_at DESC NULLS LAST, gr.id ASC`,
    values
  );

  const competencies = await pool.query(
    `SELECT cr.id, cr.competency_name, cr.weightage, cr.rating, cr.remarks,
            p.cycle_id, c.name AS cycle_name
     FROM performance_appraisal_competency_ratings cr
     JOIN performance_appraisal_participants p ON p.id = cr.participant_id
     JOIN performance_appraisal_cycles c ON c.id = p.cycle_id
     WHERE ${whereSql} AND cr.rating IS NOT NULL
     ORDER BY p.submitted_at DESC NULLS LAST, cr.id ASC`,
    values
  );

  return {
    goals: goals.rows.map((row) => ({
      id: Number(row.id),
      cycle_id: Number(row.cycle_id),
      cycle_name: row.cycle_name,
      goal_title: row.goal_title,
      weightage: Number(row.weightage),
      rating: Number(row.rating),
      achievement_status: row.achievement_status,
      remarks: row.remarks,
    })),
    competencies: competencies.rows.map((row) => ({
      id: Number(row.id),
      cycle_id: Number(row.cycle_id),
      cycle_name: row.cycle_name,
      competency_name: row.competency_name,
      weightage: Number(row.weightage),
      rating: Number(row.rating),
      remarks: row.remarks,
    })),
  };
}

async function reopenAppraisal(companyId, cycleId, participantId) {
  const detail = await getParticipantDetail(companyId, cycleId, participantId);
  if (detail.error) return detail;
  if (detail.cycle.status === 'closed') {
    return { error: [400, 'This appraisal cycle is closed. Ratings cannot be reopened.'] };
  }
  const status = detail.participant.status;
  if (!['submitted', 'pip_suggested', 'pip_dismissed'].includes(status)) {
    if (status === 'pip_created') {
      return { error: [400, 'Cannot reopen after a PIP has been created.'] };
    }
    return { error: [400, 'Only submitted appraisals can be reopened for editing.'] };
  }

  await pool.query(
    `UPDATE performance_appraisal_participants
     SET status = 'in_progress',
         submitted_at = NULL,
         submitted_by = NULL,
         updated_at = $1
     WHERE id = $2 AND company_id = $3`,
    [utcNowForPgTimestamp(), detail.participant.id, companyId]
  );

  return getParticipantDetail(companyId, cycleId, participantId);
}

async function dismissPipSuggestion(companyId, cycleId, participantId) {
  const detail = await getParticipantDetail(companyId, cycleId, participantId);
  if (detail.error) return detail;
  if (detail.participant.status !== 'pip_suggested') {
    return { error: [400, 'PIP suggestion can only be dismissed when a PIP has been suggested.'] };
  }
  await pool.query(
    `UPDATE performance_appraisal_participants
     SET status = 'pip_dismissed', updated_at = $1
     WHERE id = $2 AND company_id = $3`,
    [utcNowForPgTimestamp(), detail.participant.id, companyId]
  );
  return getParticipantDetail(companyId, cycleId, participantId);
}

module.exports = {
  createCycle,
  getCycles,
  getCycleById,
  updateCycle,
  deleteCycle,
  previewParticipant,
  addParticipants,
  listParticipants,
  getParticipantDetail,
  overrideCompetencyWeights,
  saveRatings,
  submitAppraisal,
  reopenAppraisal,
  getSummary,
  getMySummaries,
  getMySummaryItems,
  dismissPipSuggestion,
};
