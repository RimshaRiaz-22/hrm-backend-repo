const { sendSuccess, sendError } = require('../utils/apiResponse');
const {
  requireCompanyContext,
  requireEmployeeContext,
} = require('../services/performance/performance.helpers');
const competencyService = require('../services/performance/competency.service');
const templateService = require('../services/performance/competencyTemplate.service');
const goalService = require('../services/performance/goal.service');
const appraisalService = require('../services/performance/appraisal.service');
const pipService = require('../services/performance/pip.service');

function handleServiceError(res, result) {
  if (!result?.error) return false;
  const [status, message, data] = result.error;
  return sendError(res, status, message, data ?? null);
}

async function withCompany(req, res) {
  const ctx = await requireCompanyContext(req.authUser);
  if (ctx.error) {
    sendError(res, ctx.error[0], ctx.error[1]);
    return null;
  }
  return ctx;
}

async function withEmployee(req, res) {
  const ctx = await requireEmployeeContext(req.authUser);
  if (ctx.error) {
    sendError(res, ctx.error[0], ctx.error[1]);
    return null;
  }
  return ctx;
}

// ── Competencies ─────────────────────────────────────────────────────────────

async function createCompetency(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.createCompetency(ctx.companyId, req.body || {});
    if (handleServiceError(res, result)) return;
    const message = result.existing
      ? 'Competency already exists; reusing existing record.'
      : 'Competency created successfully.';
    return sendSuccess(res, result.existing ? 200 : 201, message, result);
  } catch (error) {
    console.error('createCompetency error:', error);
    return sendError(res, 500, 'Something went wrong while creating competency.');
  }
}

async function getCompetencies(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.getCompetencies(ctx.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competencies retrieved successfully.', result);
  } catch (error) {
    console.error('getCompetencies error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving competencies.');
  }
}

async function getCompetencyById(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.getCompetencyById(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency retrieved successfully.', result);
  } catch (error) {
    console.error('getCompetencyById error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving competency.');
  }
}

async function updateCompetency(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.updateCompetency(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency updated successfully.', result);
  } catch (error) {
    console.error('updateCompetency error:', error);
    return sendError(res, 500, 'Something went wrong while updating competency.');
  }
}

async function deleteCompetency(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.deleteCompetency(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency deleted successfully.', result);
  } catch (error) {
    console.error('deleteCompetency error:', error);
    return sendError(res, 500, 'Something went wrong while deleting competency.');
  }
}

async function assignCompetency(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.assignCompetency(
      ctx.companyId,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency assigned successfully.', result);
  } catch (error) {
    console.error('assignCompetency error:', error);
    return sendError(res, 500, 'Something went wrong while assigning competency.');
  }
}

async function deleteCompetencyAssignment(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await competencyService.deleteCompetencyAssignment(
      ctx.companyId,
      req.params.id,
      req.params.assignmentId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency assignment deleted successfully.', result);
  } catch (error) {
    console.error('deleteCompetencyAssignment error:', error);
    return sendError(res, 500, 'Something went wrong while deleting competency assignment.');
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

async function createTemplate(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.createTemplate(ctx.companyId, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Competency template created successfully.', result);
  } catch (error) {
    console.error('createTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while creating template.');
  }
}

async function getTemplates(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.getTemplates(ctx.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency templates retrieved successfully.', result);
  } catch (error) {
    console.error('getTemplates error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving templates.');
  }
}

async function getTemplateById(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.getTemplateById(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency template retrieved successfully.', result);
  } catch (error) {
    console.error('getTemplateById error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving template.');
  }
}

async function updateTemplate(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.updateTemplate(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency template updated successfully.', result);
  } catch (error) {
    console.error('updateTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while updating template.');
  }
}

async function deleteTemplate(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.deleteTemplate(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency template deleted successfully.', result);
  } catch (error) {
    console.error('deleteTemplate error:', error);
    return sendError(res, 500, 'Something went wrong while deleting template.');
  }
}

async function replaceTemplateItems(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.replaceTemplateItems(
      ctx.companyId,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Template items updated successfully.', result);
  } catch (error) {
    console.error('replaceTemplateItems error:', error);
    return sendError(res, 500, 'Something went wrong while updating template items.');
  }
}

async function createTemplateAssignment(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.createTemplateAssignment(
      ctx.companyId,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Template assigned successfully.', result);
  } catch (error) {
    console.error('createTemplateAssignment error:', error);
    return sendError(res, 500, 'Something went wrong while assigning template.');
  }
}

async function deleteTemplateAssignment(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await templateService.deleteTemplateAssignment(
      ctx.companyId,
      req.params.id,
      req.params.assignmentId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Template assignment deleted successfully.', result);
  } catch (error) {
    console.error('deleteTemplateAssignment error:', error);
    return sendError(res, 500, 'Something went wrong while deleting template assignment.');
  }
}

// ── Goals ────────────────────────────────────────────────────────────────────

async function createGoal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.createGoal(ctx.companyId, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Goal created successfully.', result);
  } catch (error) {
    console.error('createGoal error:', error);
    return sendError(res, 500, 'Something went wrong while creating goal.');
  }
}

async function getGoals(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.getGoals(ctx.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goals retrieved successfully.', result);
  } catch (error) {
    console.error('getGoals error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving goals.');
  }
}

async function getMyGoals(req, res) {
  const ctx = await withEmployee(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.getMyGoals(ctx.companyId, ctx.employeeId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goals retrieved successfully.', result);
  } catch (error) {
    console.error('getMyGoals error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving goals.');
  }
}

async function getEmployeeGoalSummary(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.getEmployeeGoalSummary(
      ctx.companyId,
      req.params.employeeId,
      req.query.exclude_goal_id
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Employee goal summary retrieved successfully.', result);
  } catch (error) {
    console.error('getEmployeeGoalSummary error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving employee goal summary.');
  }
}

async function getGoalById(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.getGoalById(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goal retrieved successfully.', result);
  } catch (error) {
    console.error('getGoalById error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving goal.');
  }
}

async function updateGoal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.updateGoal(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goal updated successfully.', result);
  } catch (error) {
    console.error('updateGoal error:', error);
    return sendError(res, 500, 'Something went wrong while updating goal.');
  }
}

async function deleteGoal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.deleteGoal(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goal deleted successfully.', result);
  } catch (error) {
    console.error('deleteGoal error:', error);
    return sendError(res, 500, 'Something went wrong while deleting goal.');
  }
}

async function assignGoal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.assignGoal(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goal assigned successfully.', result);
  } catch (error) {
    console.error('assignGoal error:', error);
    return sendError(res, 500, 'Something went wrong while assigning goal.');
  }
}

async function deleteGoalAssignment(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await goalService.deleteGoalAssignment(
      ctx.companyId,
      req.params.id,
      req.params.assignmentId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Goal assignment deleted successfully.', result);
  } catch (error) {
    console.error('deleteGoalAssignment error:', error);
    return sendError(res, 500, 'Something went wrong while deleting goal assignment.');
  }
}

// ── Appraisal cycles ─────────────────────────────────────────────────────────

async function createCycle(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.createCycle(ctx.companyId, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'Appraisal cycle created successfully.', result);
  } catch (error) {
    console.error('createCycle error:', error);
    return sendError(res, 500, 'Something went wrong while creating appraisal cycle.');
  }
}

async function previewParticipant(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.previewParticipant(ctx.companyId, req.params.employeeId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Participant preview retrieved successfully.', result);
  } catch (error) {
    console.error('previewParticipant error:', error);
    return sendError(res, 500, 'Something went wrong while loading participant preview.');
  }
}

async function getCycles(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getCycles(ctx.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal cycles retrieved successfully.', result);
  } catch (error) {
    console.error('getCycles error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving appraisal cycles.');
  }
}

async function getCycleById(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getCycleById(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal cycle retrieved successfully.', result);
  } catch (error) {
    console.error('getCycleById error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving appraisal cycle.');
  }
}

async function updateCycle(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.updateCycle(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal cycle updated successfully.', result);
  } catch (error) {
    console.error('updateCycle error:', error);
    return sendError(res, 500, 'Something went wrong while updating appraisal cycle.');
  }
}

async function deleteCycle(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.deleteCycle(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal cycle deleted successfully.', result);
  } catch (error) {
    console.error('deleteCycle error:', error);
    return sendError(res, 500, 'Something went wrong while deleting appraisal cycle.');
  }
}

async function addParticipants(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.addParticipants(
      ctx.companyId,
      req.params.id,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Participants added successfully.', result);
  } catch (error) {
    console.error('addParticipants error:', error);
    return sendError(res, 500, 'Something went wrong while adding participants.');
  }
}

async function listParticipants(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.listParticipants(
      ctx.companyId,
      req.params.id,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Participants retrieved successfully.', result);
  } catch (error) {
    console.error('listParticipants error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving participants.');
  }
}

async function getParticipantDetail(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getParticipantDetail(
      ctx.companyId,
      req.params.id,
      req.params.participantId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Participant appraisal retrieved successfully.', result);
  } catch (error) {
    console.error('getParticipantDetail error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving participant appraisal.');
  }
}

async function overrideCompetencyWeights(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.overrideCompetencyWeights(
      ctx.companyId,
      req.params.id,
      req.params.participantId,
      req.body || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Competency weightages updated successfully.', result);
  } catch (error) {
    console.error('overrideCompetencyWeights error:', error);
    return sendError(res, 500, 'Something went wrong while updating competency weightages.');
  }
}

async function saveRatings(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.saveRatings(
      ctx.companyId,
      req.params.id,
      req.params.participantId,
      req.body || {},
      ctx.userId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Ratings saved successfully.', result);
  } catch (error) {
    console.error('saveRatings error:', error);
    return sendError(res, 500, 'Something went wrong while saving ratings.');
  }
}

async function submitAppraisal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.submitAppraisal(
      ctx.companyId,
      req.params.id,
      req.params.participantId,
      req.body || {},
      ctx.userId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal submitted successfully.', result);
  } catch (error) {
    console.error('submitAppraisal error:', error);
    return sendError(res, 500, 'Something went wrong while submitting appraisal.');
  }
}

async function reopenAppraisal(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.reopenAppraisal(
      ctx.companyId,
      req.params.id,
      req.params.participantId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Appraisal reopened for editing.', result);
  } catch (error) {
    console.error('reopenAppraisal error:', error);
    return sendError(res, 500, 'Something went wrong while reopening appraisal.');
  }
}

async function getSummary(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getSummary(
      ctx.companyId,
      req.params.id,
      req.params.participantId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Performance summary retrieved successfully.', result);
  } catch (error) {
    console.error('getSummary error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving performance summary.');
  }
}

async function dismissPipSuggestion(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.dismissPipSuggestion(
      ctx.companyId,
      req.params.id,
      req.params.participantId
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIP suggestion dismissed successfully.', result);
  } catch (error) {
    console.error('dismissPipSuggestion error:', error);
    return sendError(res, 500, 'Something went wrong while dismissing PIP suggestion.');
  }
}

async function getMySummaries(req, res) {
  const ctx = await withEmployee(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getMySummaries(
      ctx.companyId,
      ctx.employeeId,
      req.query || {}
    );
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Performance summaries retrieved successfully.', result);
  } catch (error) {
    console.error('getMySummaries error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving performance summaries.');
  }
}

async function getMySummaryItems(req, res) {
  const ctx = await withEmployee(req, res);
  if (!ctx) return;
  try {
    const result = await appraisalService.getMySummaryItems(ctx.companyId, ctx.employeeId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'Performance summary items retrieved successfully.', result);
  } catch (error) {
    console.error('getMySummaryItems error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving performance summary items.');
  }
}

// ── PIP ──────────────────────────────────────────────────────────────────────

async function createPip(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.createPip(ctx.companyId, req.body || {}, ctx.userId);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 201, 'PIP created successfully.', result);
  } catch (error) {
    console.error('createPip error:', error);
    return sendError(res, 500, 'Something went wrong while creating PIP.');
  }
}

async function getPips(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.getPips(ctx.companyId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIPs retrieved successfully.', result);
  } catch (error) {
    console.error('getPips error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving PIPs.');
  }
}

async function getPipById(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.getPipById(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIP retrieved successfully.', result);
  } catch (error) {
    console.error('getPipById error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving PIP.');
  }
}

async function updatePip(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.updatePip(ctx.companyId, req.params.id, req.body || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIP updated successfully.', result);
  } catch (error) {
    console.error('updatePip error:', error);
    return sendError(res, 500, 'Something went wrong while updating PIP.');
  }
}

async function deletePip(req, res) {
  const ctx = await withCompany(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.deletePip(ctx.companyId, req.params.id);
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIP deleted successfully.', result);
  } catch (error) {
    console.error('deletePip error:', error);
    return sendError(res, 500, 'Something went wrong while deleting PIP.');
  }
}

async function getMyPips(req, res) {
  const ctx = await withEmployee(req, res);
  if (!ctx) return;
  try {
    const result = await pipService.getMyPips(ctx.companyId, ctx.employeeId, req.query || {});
    if (handleServiceError(res, result)) return;
    return sendSuccess(res, 200, 'PIPs retrieved successfully.', result);
  } catch (error) {
    console.error('getMyPips error:', error);
    return sendError(res, 500, 'Something went wrong while retrieving PIPs.');
  }
}

module.exports = {
  createCompetency,
  getCompetencies,
  getCompetencyById,
  updateCompetency,
  deleteCompetency,
  assignCompetency,
  deleteCompetencyAssignment,
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  replaceTemplateItems,
  createTemplateAssignment,
  deleteTemplateAssignment,
  createGoal,
  getGoals,
  getMyGoals,
  getEmployeeGoalSummary,
  getGoalById,
  updateGoal,
  deleteGoal,
  assignGoal,
  deleteGoalAssignment,
  createCycle,
  previewParticipant,
  getCycles,
  getCycleById,
  updateCycle,
  deleteCycle,
  addParticipants,
  listParticipants,
  getParticipantDetail,
  overrideCompetencyWeights,
  saveRatings,
  submitAppraisal,
  reopenAppraisal,
  getSummary,
  dismissPipSuggestion,
  getMySummaries,
  getMySummaryItems,
  createPip,
  getPips,
  getPipById,
  updatePip,
  deletePip,
  getMyPips,
};
