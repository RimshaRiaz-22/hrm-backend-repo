'use strict';

const express = require('express');
const orgChartController = require('../controllers/orgChart.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/root', ...protect('org_chart', 'view'), orgChartController.getRoot);
router.get('/departments', ...protect('org_chart', 'view'), orgChartController.getDepartments);
router.get(
  '/departments/:departmentId/managers',
  ...protect('org_chart', 'view'),
  orgChartController.getManagers
);
router.get(
  '/departments/:departmentId/managers/:managerId/reports',
  ...protect('org_chart', 'view'),
  orgChartController.getReports
);
router.get(
  '/departments/:departmentId/unassigned',
  ...protect('org_chart', 'view'),
  orgChartController.getUnassigned
);
router.get(
  '/roles/:accessRoleId/members',
  ...protect('org_chart', 'view'),
  orgChartController.getRoleMembers
);

module.exports = router;
