const express = require('express');
const employeePayslipController = require('../controllers/employeePayslip.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/me', ...protect('employee_payslips', 'view'), employeePayslipController.listMyPayslips);
router.get(
  '/me/:runId/pdf',
  ...protect('employee_payslips', 'view'),
  employeePayslipController.downloadMyPayslipPdf
);
router.get(
  '/me/:runId',
  ...protect('employee_payslips', 'view'),
  employeePayslipController.getMyPayslipDetail
);

module.exports = router;
