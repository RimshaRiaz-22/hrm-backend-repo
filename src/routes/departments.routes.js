const express = require('express');
const departmentsController = require('../controllers/departments.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('departments', 'add'), departmentsController.createDepartment);
router.get('/', ...protect('departments', 'view'), departmentsController.getDepartments);
router.get('/summary', ...protect('departments', 'view'), departmentsController.getDepartmentSummary);
router.patch('/:id/status', ...protect('departments', 'edit'), departmentsController.updateDepartmentStatus);
router.get('/:id', ...protect('departments', 'view'), departmentsController.getDepartmentById);
router.patch('/:id', ...protect('departments', 'edit'), departmentsController.updateDepartment);
router.delete('/:id', ...protect('departments', 'delete'), departmentsController.deleteDepartment);

module.exports = router;
