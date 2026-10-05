const express = require('express');
const employeeDashboardController = require('../controllers/employeeDashboard.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get(
  '/status-today',
  ...protect('employee_dashboard', 'view'),
  employeeDashboardController.getEmployeeStatusToday
);
router.get(
  '/leave-balances',
  ...protect('employee_dashboard', 'view'),
  employeeDashboardController.getEmployeeLeaveBalances
);
router.get(
  '/pending-requests',
  ...protect('employee_dashboard', 'view'),
  employeeDashboardController.getEmployeePendingRequests
);
router.get(
  '/attendance-month',
  ...protect('employee_dashboard', 'view'),
  employeeDashboardController.getEmployeeAttendanceMonth
);

module.exports = router;
