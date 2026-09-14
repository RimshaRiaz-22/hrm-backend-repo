const express = require('express');
const payrollAssignmentsController = require('../controllers/payrollAssignments.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/bulk', ...protect('payroll_assignments', 'add'), payrollAssignmentsController.bulkAssignPayroll);
router.get(
  '/missing-schedule',
  ...protect('payroll_assignments', 'view'),
  payrollAssignmentsController.listEmployeesMissingSchedule
);

module.exports = router;
