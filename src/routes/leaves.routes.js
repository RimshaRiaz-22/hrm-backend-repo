const express = require('express');
const leaveController = require('../controllers/leave.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/policies', ...protect('leave_policies', 'add'), leaveController.createLeavePolicy);
router.post('/policies/import', ...protect('leave_policies', 'add'), leaveController.importLeavePolicies);
router.get('/policies/me', ...protect('leave_policies', 'view'), leaveController.getMyLeavePolicies);
router.get('/policies/me/:id', ...protect('leave_policies', 'view'), leaveController.getMyLeavePolicyById);
router.get('/policies', ...protect('leave_policies', 'view'), leaveController.getLeavePolicies);
// Keep outside /policies/:id so "cycle-history" is never parsed as a policy id.
router.get(
  '/policy-cycle-history',
  ...protect('leave_policies', 'view'),
  leaveController.getLeavePolicyCycleHistory
);
router.get('/policies/:id', ...protect('leave_policies', 'view'), leaveController.getLeavePolicyById);
router.patch('/policies/:id', ...protect('leave_policies', 'edit'), leaveController.updateLeavePolicy);
router.delete('/policies/:id', ...protect('leave_policies', 'delete'), leaveController.deleteLeavePolicy);
router.get(
  '/policies/:id/approval-steps',
  ...protect('leave_policies', 'view'),
  leaveController.getLeavePolicyApprovalSteps
);
router.put(
  '/policies/:id/approval-steps',
  ...protect('leave_policies', 'edit'),
  leaveController.updateLeavePolicyApprovalSteps
);

router.get('/balances/me', ...protect('leave_balances', 'view'), leaveController.getMyLeaveBalances);
router.get('/balances', ...protect('leave_balances', 'view'), leaveController.getLeaveBalances);
router.get('/balances/:id', ...protect('leave_balances', 'view'), leaveController.getLeaveBalanceById);
router.patch('/balances/:id', ...protect('leave_balances', 'edit'), leaveController.updateLeaveBalance);
router.delete('/balances/:id', ...protect('leave_balances', 'delete'), leaveController.deleteLeaveBalance);

router.post('/requests', ...protect('leave_requests', 'add'), leaveController.createLeaveRequest);
router.get('/requests/me', ...protect('leave_requests', 'view'), leaveController.getMyLeaveRequests);
router.get('/requests/me/:id', ...protect('leave_requests', 'view'), leaveController.getMyLeaveRequestById);
router.patch(
  '/requests/me/:id/cancel',
  ...protect('leave_requests', 'edit'),
  leaveController.cancelMyLeaveRequest
);
router.get('/requests/team', ...protect('leave_requests', 'view'), leaveController.getTeamLeaveRequests);
router.get('/requests/team/:id', ...protect('leave_requests', 'view'), leaveController.getTeamLeaveRequestById);
router.patch(
  '/requests/team/:id/status',
  ...protect('leave_requests', 'edit'),
  leaveController.updateTeamLeaveRequestStatus
);
router.get('/requests', ...protect('leave_requests', 'view'), leaveController.getLeaveRequests);
router.get('/requests/:id', ...protect('leave_requests', 'view'), leaveController.getLeaveRequestById);
router.patch(
  '/requests/:id/status',
  ...protect('leave_requests', 'edit'),
  leaveController.updateLeaveRequestStatus
);

module.exports = router;
