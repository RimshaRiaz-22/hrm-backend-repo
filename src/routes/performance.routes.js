const express = require('express');
const performanceController = require('../controllers/performance.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

// Competencies
router.post('/competencies', ...protect('performance_competencies', 'add'), performanceController.createCompetency);
router.get('/competencies', ...protect('performance_competencies', 'view'), performanceController.getCompetencies);
router.get('/competencies/:id', ...protect('performance_competencies', 'view'), performanceController.getCompetencyById);
router.patch('/competencies/:id', ...protect('performance_competencies', 'edit'), performanceController.updateCompetency);
router.delete('/competencies/:id', ...protect('performance_competencies', 'delete'), performanceController.deleteCompetency);
router.post('/competencies/:id/assignments', ...protect('performance_competencies', 'edit'), performanceController.assignCompetency);
router.delete('/competencies/:id/assignments/:assignmentId', ...protect('performance_competencies', 'edit'), performanceController.deleteCompetencyAssignment);

// Competency templates
router.post('/competency-templates', ...protect('performance_templates', 'add'), performanceController.createTemplate);
router.get('/competency-templates', ...protect('performance_templates', 'view'), performanceController.getTemplates);
router.get('/competency-templates/:id', ...protect('performance_templates', 'view'), performanceController.getTemplateById);
router.patch('/competency-templates/:id', ...protect('performance_templates', 'edit'), performanceController.updateTemplate);
router.delete('/competency-templates/:id', ...protect('performance_templates', 'delete'), performanceController.deleteTemplate);
router.put('/competency-templates/:id/items', ...protect('performance_templates', 'edit'), performanceController.replaceTemplateItems);
router.post('/competency-templates/:id/assignments', ...protect('performance_templates', 'edit'), performanceController.createTemplateAssignment);
router.delete('/competency-templates/:id/assignments/:assignmentId', ...protect('performance_templates', 'edit'), performanceController.deleteTemplateAssignment);

// Goals — literal /me before /:id
router.get('/goals/me', ...protect('performance_goals', 'view'), performanceController.getMyGoals);
router.get(
  '/goals/employee/:employeeId/summary',
  ...protect('performance_goals', 'view'),
  performanceController.getEmployeeGoalSummary
);
router.post('/goals', ...protect('performance_goals', 'add'), performanceController.createGoal);
router.get('/goals', ...protect('performance_goals', 'view'), performanceController.getGoals);
router.get('/goals/:id', ...protect('performance_goals', 'view'), performanceController.getGoalById);
router.patch('/goals/:id', ...protect('performance_goals', 'edit'), performanceController.updateGoal);
router.delete('/goals/:id', ...protect('performance_goals', 'delete'), performanceController.deleteGoal);
router.post('/goals/:id/assignments', ...protect('performance_goals', 'edit'), performanceController.assignGoal);
router.delete('/goals/:id/assignments/:assignmentId', ...protect('performance_goals', 'edit'), performanceController.deleteGoalAssignment);

// Appraisal cycles
router.get('/summaries/me', ...protect('performance_appraisals', 'view'), performanceController.getMySummaries);
router.get('/summaries/me/items', ...protect('performance_appraisals', 'view'), performanceController.getMySummaryItems);
router.post('/appraisal-cycles', ...protect('performance_appraisals', 'add'), performanceController.createCycle);
router.get('/appraisal-cycles', ...protect('performance_appraisals', 'view'), performanceController.getCycles);
router.get(
  '/appraisal-cycles/participant-preview/:employeeId',
  ...protect('performance_appraisals', 'view'),
  performanceController.previewParticipant
);
router.get('/appraisal-cycles/:id', ...protect('performance_appraisals', 'view'), performanceController.getCycleById);
router.patch('/appraisal-cycles/:id', ...protect('performance_appraisals', 'edit'), performanceController.updateCycle);
router.delete('/appraisal-cycles/:id', ...protect('performance_appraisals', 'delete'), performanceController.deleteCycle);
router.post('/appraisal-cycles/:id/participants', ...protect('performance_appraisals', 'edit'), performanceController.addParticipants);
router.get('/appraisal-cycles/:id/participants', ...protect('performance_appraisals', 'view'), performanceController.listParticipants);
router.get('/appraisal-cycles/:id/participants/:participantId', ...protect('performance_appraisals', 'view'), performanceController.getParticipantDetail);
router.put('/appraisal-cycles/:id/participants/:participantId/competency-weights', ...protect('performance_appraisals', 'edit'), performanceController.overrideCompetencyWeights);
router.patch('/appraisal-cycles/:id/participants/:participantId/ratings', ...protect('performance_appraisals', 'edit'), performanceController.saveRatings);
router.post('/appraisal-cycles/:id/participants/:participantId/submit', ...protect('performance_appraisals', 'edit'), performanceController.submitAppraisal);
router.post('/appraisal-cycles/:id/participants/:participantId/reopen', ...protect('performance_appraisals', 'edit'), performanceController.reopenAppraisal);
router.get('/appraisal-cycles/:id/participants/:participantId/summary', ...protect('performance_appraisals', 'view'), performanceController.getSummary);
router.post('/appraisal-cycles/:id/participants/:participantId/dismiss-pip', ...protect('performance_appraisals', 'edit'), performanceController.dismissPipSuggestion);

// PIP — literal /me before /:id
router.get('/pips/me', ...protect('performance_pip', 'view'), performanceController.getMyPips);
router.post('/pips', ...protect('performance_pip', 'add'), performanceController.createPip);
router.get('/pips', ...protect('performance_pip', 'view'), performanceController.getPips);
router.get('/pips/:id', ...protect('performance_pip', 'view'), performanceController.getPipById);
router.patch('/pips/:id', ...protect('performance_pip', 'edit'), performanceController.updatePip);
router.delete('/pips/:id', ...protect('performance_pip', 'delete'), performanceController.deletePip);

module.exports = router;
