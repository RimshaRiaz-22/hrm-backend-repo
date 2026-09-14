const express = require('express');
const employeeBankDetailsController = require('../controllers/employeeBankDetails.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('employee_bank_details', 'add'), employeeBankDetailsController.createEmployeeBankDetails);
router.get('/', ...protect('employee_bank_details', 'view'), employeeBankDetailsController.getAllEmployeeBankDetails);
router.get(
  '/:employee_id',
  ...protect('employee_bank_details', 'view'),
  employeeBankDetailsController.getEmployeeBankDetailsByEmployeeId
);
router.put('/:id', ...protect('employee_bank_details', 'edit'), employeeBankDetailsController.updateEmployeeBankDetails);
router.delete('/:id', ...protect('employee_bank_details', 'delete'), employeeBankDetailsController.deleteEmployeeBankDetails);

module.exports = router;
