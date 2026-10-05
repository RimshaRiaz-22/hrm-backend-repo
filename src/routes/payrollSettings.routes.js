const express = require('express');
const ctrl = require('../controllers/payrollSettings.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/schedules', ...protect('payroll_schedules', 'add'), ctrl.createSchedule);
router.get('/schedules', ...protect('payroll_schedules', 'view'), ctrl.listSchedules);
router.patch('/schedules/:id', ...protect('payroll_schedules', 'edit'), ctrl.updateSchedule);
router.delete('/schedules/:id', ...protect('payroll_schedules', 'delete'), ctrl.deleteSchedule);

router.post('/allowances', ...protect('payroll_allowances', 'add'), ctrl.createAllowance);
router.post('/allowances/import', ...protect('payroll_allowances', 'add'), ctrl.importAllowances);
router.get('/allowances', ...protect('payroll_allowances', 'view'), ctrl.listAllowances);
router.patch('/allowances/:id', ...protect('payroll_allowances', 'edit'), ctrl.updateAllowance);
router.delete('/allowances/:id', ...protect('payroll_allowances', 'delete'), ctrl.deleteAllowance);

router.post('/deductions', ...protect('payroll_deductions', 'add'), ctrl.createDeduction);
router.post('/deductions/import', ...protect('payroll_deductions', 'add'), ctrl.importDeductions);
router.get('/deductions', ...protect('payroll_deductions', 'view'), ctrl.listDeductions);
router.patch('/deductions/:id', ...protect('payroll_deductions', 'edit'), ctrl.updateDeduction);
router.delete('/deductions/:id', ...protect('payroll_deductions', 'delete'), ctrl.deleteDeduction);

router.post('/contributions', ...protect('payroll_contributions', 'add'), ctrl.createContribution);
router.post('/contributions/import', ...protect('payroll_contributions', 'add'), ctrl.importContributions);
router.get('/contributions', ...protect('payroll_contributions', 'view'), ctrl.listContributions);
router.patch('/contributions/:id', ...protect('payroll_contributions', 'edit'), ctrl.updateContribution);
router.delete('/contributions/:id', ...protect('payroll_contributions', 'delete'), ctrl.deleteContribution);

router.post('/templates', ...protect('payroll_salary_templates', 'add'), ctrl.createTemplate);
router.get('/templates', ...protect('payroll_salary_templates', 'view'), ctrl.listTemplates);
router.get('/templates/:id', ...protect('payroll_salary_templates', 'view'), ctrl.getTemplate);
router.patch('/templates/:id', ...protect('payroll_salary_templates', 'edit'), ctrl.updateTemplate);
router.post(
  '/templates/:id/assign-employees',
  ...protect('payroll_salary_templates', 'edit'),
  ctrl.assignTemplateEmployees
);
router.delete('/templates/:id', ...protect('payroll_salary_templates', 'delete'), ctrl.deleteTemplate);

module.exports = router;
