const express = require('express');
const employeeTypesController = require('../controllers/employeeTypes.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('employee_types', 'add'), employeeTypesController.createEmployeeType);
router.get('/', ...protect('employee_types', 'view'), employeeTypesController.getEmployeeTypes);
router.get('/:id', ...protect('employee_types', 'view'), employeeTypesController.getEmployeeTypeById);
router.patch('/:id', ...protect('employee_types', 'edit'), employeeTypesController.updateEmployeeType);
router.delete('/:id', ...protect('employee_types', 'delete'), employeeTypesController.deleteEmployeeType);

module.exports = router;
