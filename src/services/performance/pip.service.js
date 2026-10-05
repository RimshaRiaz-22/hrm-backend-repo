const { parseListPagination, buildListPaginationMeta } = require('../pagination.service');
const {
  pool,
  parsePositiveInt,
  utcNowForPgTimestamp,
  toUtcIsoString,
} = require('./performance.helpers');

function mapPip(row) {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    participant_id: Number(row.participant_id),
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_email: row.employee_email || null,
    cycle_id: Number(row.cycle_id),
    cycle_name: row.cycle_name || null,
    duration_days: row.duration_days != null ? Number(row.duration_days) : null,
    focus_areas: row.focus_areas || null,
    check_in_schedule: row.check_in_schedule || null,
    progress_notes: row.progress_notes || null,
    final_outcome: row.final_outcome || null,
    status: row.status,
    final_rating: row.final_rating != null ? Number(row.final_rating) : null,
    created_at: toUtcIsoString(row.created_at),
    updated_at: toUtcIsoString(row.updated_at),
  };
}

async function createPip(companyId, body = {}, userId) {
  const participantId = parsePositiveInt(body.participant_id);
  if (!participantId) return { error: [400, 'Please select an employee for the PIP.'] };

  const participantResult = await pool.query(
    `SELECT p.*, c.name AS cycle_name
     FROM performance_appraisal_participants p
     JOIN performance_appraisal_cycles c ON c.id = p.cycle_id
     WHERE p.id = $1 AND p.company_id = $2`,
    [participantId, companyId]
  );
  if (participantResult.rowCount === 0) return { error: [404, 'Participant not found.'] };
  const participant = participantResult.rows[0];

  if (!['pip_suggested', 'submitted'].includes(participant.status)) {
    if (participant.final_rating == null || Number(participant.final_rating) > 2) {
      return { error: [400, 'PIP can only be created when the final rating is 2 or below.'] };
    }
  }

  const durationDays =
    body.duration_days === undefined || body.duration_days === null || body.duration_days === ''
      ? null
      : parsePositiveInt(body.duration_days);
  if (
    body.duration_days !== undefined &&
    body.duration_days !== null &&
    body.duration_days !== '' &&
    !durationDays
  ) {
    return { error: [400, 'Please enter a valid duration in days.'] };
  }

  const now = utcNowForPgTimestamp();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO performance_pips
         (company_id, participant_id, employee_id, cycle_id, duration_days, focus_areas,
          check_in_schedule, progress_notes, final_outcome, status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$11)
       ON CONFLICT (participant_id) DO UPDATE SET
         duration_days = EXCLUDED.duration_days,
         focus_areas = EXCLUDED.focus_areas,
         check_in_schedule = EXCLUDED.check_in_schedule,
         progress_notes = EXCLUDED.progress_notes,
         final_outcome = EXCLUDED.final_outcome,
         status = 'active',
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        companyId,
        participant.id,
        participant.employee_id,
        participant.cycle_id,
        durationDays,
        body.focus_areas != null ? String(body.focus_areas).trim() || null : null,
        body.check_in_schedule != null ? String(body.check_in_schedule).trim() || null : null,
        body.progress_notes != null ? String(body.progress_notes).trim() || null : null,
        body.final_outcome != null ? String(body.final_outcome).trim() || null : null,
        userId || null,
        now,
      ]
    );
    await client.query(
      `UPDATE performance_appraisal_participants
       SET status = 'pip_created', updated_at = $1
       WHERE id = $2 AND company_id = $3`,
      [now, participant.id, companyId]
    );
    await client.query('COMMIT');
    return { pip: mapPip({ ...result.rows[0], cycle_name: participant.cycle_name }) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getPips(companyId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId];
  const filters = ['pip.company_id = $1'];
  let idx = 2;

  if (query.status) {
    const status = String(query.status).trim().toLowerCase();
    if (!['active', 'completed', 'cancelled'].includes(status)) {
      return { error: [400, 'Invalid PIP status filter.'] };
    }
    filters.push(`pip.status = $${idx++}`);
    values.push(status);
  }

  const search = String(query.search || '').trim();
  if (search) {
    filters.push(
      `(CONCAT(e.first_name, ' ', e.last_name) ILIKE $${idx} OR c.name ILIKE $${idx})`
    );
    values.push(`%${search}%`);
    idx += 1;
  }

  const whereSql = filters.join(' AND ');
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM performance_pips pip
     JOIN employees e ON e.id = pip.employee_id
     JOIN performance_appraisal_cycles c ON c.id = pip.cycle_id
     WHERE ${whereSql}`,
    values
  );

  const listSql = `
    SELECT pip.*,
           CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
           e.work_email AS employee_email,
           c.name AS cycle_name,
           p.final_rating
    FROM performance_pips pip
    JOIN employees e ON e.id = pip.employee_id
    JOIN performance_appraisal_cycles c ON c.id = pip.cycle_id
    JOIN performance_appraisal_participants p ON p.id = pip.participant_id
    WHERE ${whereSql}
    ORDER BY pip.created_at DESC, pip.id DESC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(`${listSql} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...values,
        listPagination.pagination.limit,
        listPagination.pagination.offset,
      ]);

  return {
    pips: result.rows.map(mapPip),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

async function getPipById(companyId, id) {
  const pipId = parsePositiveInt(id);
  if (!pipId) return { error: [400, 'Invalid PIP id.'] };
  const result = await pool.query(
    `SELECT pip.*,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
            e.work_email AS employee_email,
            c.name AS cycle_name,
            p.final_rating
     FROM performance_pips pip
     JOIN employees e ON e.id = pip.employee_id
     JOIN performance_appraisal_cycles c ON c.id = pip.cycle_id
     JOIN performance_appraisal_participants p ON p.id = pip.participant_id
     WHERE pip.id = $1 AND pip.company_id = $2`,
    [pipId, companyId]
  );
  if (result.rowCount === 0) return { error: [404, 'PIP not found.'] };
  return { pip: mapPip(result.rows[0]) };
}

async function updatePip(companyId, id, body = {}) {
  const existing = await getPipById(companyId, id);
  if (existing.error) return existing;

  let status = existing.pip.status;
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    status = String(body.status).trim().toLowerCase();
    if (!['active', 'completed', 'cancelled'].includes(status)) {
      return { error: [400, 'Please select a valid PIP status.'] };
    }
  }

  let durationDays = existing.pip.duration_days;
  if (body.duration_days !== undefined) {
    if (body.duration_days === null || body.duration_days === '') {
      durationDays = null;
    } else {
      durationDays = parsePositiveInt(body.duration_days);
      if (!durationDays) return { error: [400, 'Please enter a valid duration in days.'] };
    }
  }

  const now = utcNowForPgTimestamp();
  const result = await pool.query(
    `UPDATE performance_pips
     SET duration_days = $1,
         focus_areas = COALESCE($2, focus_areas),
         check_in_schedule = COALESCE($3, check_in_schedule),
         progress_notes = COALESCE($4, progress_notes),
         final_outcome = COALESCE($5, final_outcome),
         status = $6,
         updated_at = $7
     WHERE id = $8 AND company_id = $9
     RETURNING *`,
    [
      durationDays,
      body.focus_areas !== undefined ? String(body.focus_areas || '').trim() || null : null,
      body.check_in_schedule !== undefined
        ? String(body.check_in_schedule || '').trim() || null
        : null,
      body.progress_notes !== undefined ? String(body.progress_notes || '').trim() || null : null,
      body.final_outcome !== undefined ? String(body.final_outcome || '').trim() || null : null,
      status,
      now,
      existing.pip.id,
      companyId,
    ]
  );

  return getPipById(companyId, result.rows[0].id);
}

async function deletePip(companyId, id) {
  const existing = await getPipById(companyId, id);
  if (existing.error) return existing;

  const now = utcNowForPgTimestamp();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM performance_pips WHERE id = $1 AND company_id = $2`, [
      existing.pip.id,
      companyId,
    ]);
    // Restore participant so a new PIP can be created for the same appraisal.
    await client.query(
      `UPDATE performance_appraisal_participants
       SET status = CASE
             WHEN status = 'pip_created' THEN 'pip_suggested'
             ELSE status
           END,
           updated_at = $1
       WHERE id = $2 AND company_id = $3`,
      [now, existing.pip.participant_id, companyId]
    );
    await client.query('COMMIT');
    return { deleted: true, id: existing.pip.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getMyPips(companyId, employeeId, query = {}) {
  const listPagination = parseListPagination(query);
  if (listPagination.error) return { error: [400, listPagination.error] };

  const values = [companyId, employeeId];
  const whereSql = 'pip.company_id = $1 AND pip.employee_id = $2';
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM performance_pips pip WHERE ${whereSql}`,
    values
  );
  const listSql = `
    SELECT pip.*, c.name AS cycle_name, p.final_rating
    FROM performance_pips pip
    JOIN performance_appraisal_cycles c ON c.id = pip.cycle_id
    JOIN performance_appraisal_participants p ON p.id = pip.participant_id
    WHERE ${whereSql}
    ORDER BY pip.created_at DESC, pip.id DESC`;

  const result = listPagination.noPagination
    ? await pool.query(listSql, values)
    : await pool.query(
        `${listSql} LIMIT $3 OFFSET $4`,
        [...values, listPagination.pagination.limit, listPagination.pagination.offset]
      );

  return {
    pips: result.rows.map(mapPip),
    pagination: buildListPaginationMeta(countResult.rows[0]?.total, listPagination),
  };
}

module.exports = {
  createPip,
  getPips,
  getPipById,
  updatePip,
  deletePip,
  getMyPips,
};
