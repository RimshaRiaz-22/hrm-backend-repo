const express = require('express');
const hrDashboardController = require('../controllers/hrDashboard.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/summary', ...protect('hr_dashboard', 'view'), hrDashboardController.getHrDashboardSummary);
router.get(
  '/action-required',
  ...protect('hr_dashboard', 'view'),
  hrDashboardController.getHrActionRequired
);
router.get(
  '/attendance-snapshot',
  ...protect('hr_dashboard', 'view'),
  hrDashboardController.getHrAttendanceSnapshot
);
router.get('/upcoming', ...protect('hr_dashboard', 'view'), hrDashboardController.getHrUpcoming);
router.get(
  '/leave-overview',
  ...protect('hr_dashboard', 'view'),
  hrDashboardController.getHrLeaveOverview
);
router.get('/workforce', ...protect('hr_dashboard', 'view'), hrDashboardController.getHrWorkforce);

module.exports = router;
