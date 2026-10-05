const express = require('express');
const ctrl = require('../controllers/payrollRun.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();
const mod = 'payroll_runs';

router.post('/preview', ...protect(mod, 'view'), ctrl.preview);
router.post('/', ...protect(mod, 'add'), ctrl.create);
router.get('/', ...protect(mod, 'view'), ctrl.list);
router.patch('/:id/transition', ...protect(mod, 'edit'), ctrl.transition);
router.post('/:id/rebuild', ...protect(mod, 'edit'), ctrl.rebuildDraft);
router.patch('/:id/bulk-update', ...protect(mod, 'edit'), ctrl.bulkUpdate);
router.get('/:id/import-template', ...protect(mod, 'view'), ctrl.downloadImportTemplate);
router.post('/:id/import/validate', ...protect(mod, 'edit'), ctrl.validateImportRows);
router.post('/:id/import/commit', ...protect(mod, 'edit'), ctrl.importRows);
router.post('/:id/import', ...protect(mod, 'add'), ctrl.importRows);
router.post('/:id/email-payslips', ...protect(mod, 'edit'), ctrl.emailPayslips);
router.get('/:id/export', ...protect(mod, 'view'), ctrl.exportSheet);
router.get('/:id/skipped', ...protect(mod, 'view'), ctrl.getSkipped);
router.get('/:id/employees/:employeeId', ...protect(mod, 'view'), ctrl.getEmployee);
router.patch('/:id/employees/:employeeId', ...protect(mod, 'edit'), ctrl.updateEmployee);
router.get('/:id/employees', ...protect(mod, 'view'), ctrl.listEmployees);
router.get('/:id', ...protect(mod, 'view'), ctrl.getOne);
router.delete('/:id', ...protect(mod, 'delete'), ctrl.remove);

module.exports = router;
