const express = require('express');
const employeeReminderController = require('../controllers/employeeReminder.controller');
const { withPermissions } = require('../middleware/routeProtection');

const router = express.Router();

// Deliberately not permission-gated by module — any authenticated user can see their own
// (or, for HR reviewer roles, their company's) reminders. Scope is decided inside the
// service layer (getReminderViewerContext), not by the access-role permission matrix.
router.get('/', ...withPermissions(), employeeReminderController.listEmployeeReminders);

module.exports = router;
