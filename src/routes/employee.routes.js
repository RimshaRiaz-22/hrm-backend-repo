const express = require('express');
const employeeController = require('../controllers/employee.controller');
const payrollAssignmentsController = require('../controllers/payrollAssignments.controller');
const { protect } = require('../middleware/routeProtection');
const { validatePhoneFields } = require('../middleware/validatePhoneFields');
const { validateCurrencyFields } = require('../middleware/validateCurrencyFields');

const router = express.Router();

const employeePhoneValidationOnCreate = validatePhoneFields([
  {
    paths: ['phone_number', 'home_phone', 'personal.phone_no', 'personal.phone_number'],
    required: true,
    fieldName: 'phone number',
    writePaths: ['phone_number', 'home_phone', 'personal.phone_no'],
  },
  {
    paths: ['work_phone_mobile', 'business_phone_number', 'personal.work_phone_mobile'],
    required: false,
    fieldName: 'work phone',
    writePaths: ['work_phone_mobile', 'personal.work_phone_mobile'],
  },
]);

const employeePhoneValidationOnUpdate = validatePhoneFields([
  {
    paths: ['phone_number', 'home_phone', 'personal.phone_no', 'personal.phone_number'],
    required: false,
    fieldName: 'phone number',
    writePaths: ['phone_number', 'home_phone', 'personal.phone_no'],
  },
  {
    paths: ['work_phone_mobile', 'business_phone_number', 'personal.work_phone_mobile'],
    required: false,
    fieldName: 'work phone',
    writePaths: ['work_phone_mobile', 'personal.work_phone_mobile'],
  },
]);

const employeeCurrencyValidation = validateCurrencyFields([
  {
    paths: ['salary.currency', 'currency'],
    required: false,
    writePaths: ['salary.currency', 'currency'],
  },
]);

router.post(
  '/',
  ...protect('employees', 'add'),
  employeePhoneValidationOnCreate,
  employeeCurrencyValidation,
  employeeController.addEmployee
);
router.post(
  '/bulk',
  ...protect('employees', 'add'),
  employeeCurrencyValidation,
  employeeController.bulkAddEmployees
);
router.get('/', ...protect('employees', 'view'), employeeController.getEmployees);
router.post('/shifts', ...protect('shifts', 'add'), employeeController.createShift);
router.get('/shifts', ...protect('shifts', 'view'), employeeController.getShifts);

router.get(
  '/:id/payroll',
  ...protect('payroll_assignments', 'view'),
  payrollAssignmentsController.getEmployeePayroll
);
router.patch(
  '/:id/payroll',
  ...protect('payroll_assignments', 'edit'),
  payrollAssignmentsController.updateEmployeePayroll
);
router.post(
  '/:id/payroll/elements',
  ...protect('payroll_assignments', 'add'),
  payrollAssignmentsController.addEmployeePayrollElement
);
router.patch(
  '/:id/payroll/elements/:payElementId',
  ...protect('payroll_assignments', 'edit'),
  payrollAssignmentsController.updateEmployeePayrollElement
);
router.delete(
  '/:id/payroll/elements/:payElementId',
  ...protect('payroll_assignments', 'delete'),
  payrollAssignmentsController.removeEmployeePayrollElement
);

router.get('/:id', ...protect('employees', 'view'), employeeController.getEmployeeById);
router.patch(
  '/:id/account-access',
  ...protect('employees', 'edit'),
  employeeController.updateEmployeeAccountAccess
);
router.patch(
  '/:id',
  ...protect('employees', 'edit'),
  employeePhoneValidationOnUpdate,
  employeeCurrencyValidation,
  employeeController.updateEmployeeById
);
router.delete('/:id', ...protect('employees', 'delete'), employeeController.deleteEmployeeById);

module.exports = router;
