const express = require('express');
const salariesController = require('../controllers/salaries.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/payroll-types', ...protect('salaries', 'view'), salariesController.getPayrollTypes);
router.post('/', ...protect('salaries', 'add'), salariesController.createSalary);
router.get('/', ...protect('salaries', 'view'), salariesController.getSalaries);
router.get('/:id', ...protect('salaries', 'view'), salariesController.getSalaryById);
router.patch('/:id', ...protect('salaries', 'edit'), salariesController.updateSalary);
router.delete('/:id', ...protect('salaries', 'delete'), salariesController.deleteSalary);

module.exports = router;
