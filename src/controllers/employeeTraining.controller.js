const pool = require('../db');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { toUtcIsoString } = require('../utils/dateTime');
const { getAuthenticatedEmployeeContext } = require('../services/documentAuth.service');

/** BIGINT from node-pg — JSON-safe number (or string if out of safe range). */
function serializeRowId(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'bigint') {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val.toString();
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : String(val);
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Fetches this employee's active training materials in a fixed order (created_at ASC, id ASC —
 * same order admins add them in) with their own completion status, and derives is_unlocked:
 * sequential — an item unlocks once every item before it in that order has been completed.
 */
async function fetchMyTrainingWithProgress(db, employeeId, companyId) {
  const result = await db.query(
    `SELECT tm.id, tm.name, tm.description, tm.type, tm.file_url, tm.file_name, tm.created_at,
            tc.completed_at
     FROM training_materials tm
     LEFT JOIN training_completions tc ON tc.training_material_id = tm.id AND tc.employee_id = $1
     WHERE tm.company_id = $2 AND tm.is_active = true
     ORDER BY tm.created_at ASC, tm.id ASC`,
    [employeeId, companyId]
  );

  let previousCompleted = true;
  let completedCount = 0;
  const items = result.rows.map((row) => {
    const isCompleted = row.completed_at != null;
    const isUnlocked = previousCompleted;
    previousCompleted = isCompleted;
    if (isCompleted) completedCount += 1;

    return {
      id: serializeRowId(row.id),
      training_material_id: serializeRowId(row.id),
      name: row.name,
      description: row.description,
      type: row.type,
      file_url: row.file_url,
      file_name: row.file_name,
      created_at: toUtcIsoString(row.created_at),
      completed_at: toUtcIsoString(row.completed_at),
      is_completed: isCompleted,
      is_unlocked: isUnlocked,
    };
  });

  return { items, completedCount, totalCount: items.length };
}

/** GET /api/v1/employee-training */
async function listMyTrainingMaterials(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  try {
    const { items, completedCount, totalCount } = await fetchMyTrainingWithProgress(
      pool,
      auth.employeeId,
      auth.companyId
    );

    const empResult = await pool.query(`SELECT lms_required, lms_completed_at FROM employees WHERE id = $1`, [
      auth.employeeId,
    ]);
    const employee = empResult.rows[0] || {};

    return sendSuccess(res, 200, 'Training materials fetched successfully.', {
      training_materials: items,
      completed_count: completedCount,
      total_count: totalCount,
      lms_required: employee.lms_required === true,
      lms_completed_at: toUtcIsoString(employee.lms_completed_at),
    });
  } catch (error) {
    console.error('listMyTrainingMaterials error:', error);
    return sendError(res, 500, 'Something went wrong while fetching training materials.');
  }
}

/** POST /api/v1/employee-training/:trainingMaterialId/complete — marks one item as read/watched. */
async function completeMyTrainingItem(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const trainingMaterialId = parsePositiveInt(req.params.trainingMaterialId);
  if (!trainingMaterialId) return sendError(res, 400, 'trainingMaterialId must be a positive integer.');

  try {
    const { items } = await fetchMyTrainingWithProgress(pool, auth.employeeId, auth.companyId);
    const target = items.find((item) => String(item.training_material_id) === String(trainingMaterialId));
    if (!target) return sendError(res, 404, 'Training material not found.');
    if (target.is_completed) {
      return sendSuccess(res, 200, 'Already marked complete.', { training_material_id: target.training_material_id, completed_at: target.completed_at });
    }
    if (!target.is_unlocked) {
      return sendError(res, 400, 'Complete the previous training items first.');
    }

    const result = await pool.query(
      `INSERT INTO training_completions (employee_id, company_id, training_material_id, completed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (employee_id, training_material_id) DO NOTHING
       RETURNING completed_at`,
      [auth.employeeId, auth.companyId, trainingMaterialId]
    );

    return sendSuccess(res, 200, 'Training item marked complete.', {
      training_material_id: trainingMaterialId,
      completed_at: toUtcIsoString(result.rows[0]?.completed_at) || target.completed_at,
    });
  } catch (error) {
    console.error('completeMyTrainingItem error:', error);
    return sendError(res, 500, 'Something went wrong while marking the training item complete.');
  }
}

/** POST /api/v1/employee-training/complete — unlocks the rest of the portal (all items must be done first). */
async function completeMyTraining(req, res) {
  const auth = await getAuthenticatedEmployeeContext(req.authUser);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  try {
    const { completedCount, totalCount } = await fetchMyTrainingWithProgress(pool, auth.employeeId, auth.companyId);
    if (completedCount < totalCount) {
      return sendError(res, 400, 'Complete all training items before continuing.', {
        completed_count: completedCount,
        total_count: totalCount,
      });
    }

    const updated = await pool.query(
      `UPDATE employees
       SET lms_completed_at = COALESCE(lms_completed_at, NOW())
       WHERE id = $1 AND company_id = $2
       RETURNING lms_completed_at`,
      [auth.employeeId, auth.companyId]
    );
    if (updated.rowCount === 0) return sendError(res, 404, 'Employee not found.');

    return sendSuccess(res, 200, 'Training marked as complete.', {
      lms_completed_at: toUtcIsoString(updated.rows[0].lms_completed_at),
    });
  } catch (error) {
    console.error('completeMyTraining error:', error);
    return sendError(res, 500, 'Something went wrong while marking training complete.');
  }
}

module.exports = {
  listMyTrainingMaterials,
  completeMyTrainingItem,
  completeMyTraining,
};
