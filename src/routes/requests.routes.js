const express = require('express');
const requestsController = require('../controllers/requests.controller');
const financialController = require('../controllers/financial.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('hr_requests', 'add'), requestsController.createRequest);
router.get('/resignation/preview', ...protect('hr_requests', 'view'), requestsController.previewResignation);
router.get('/my', ...protect('hr_requests', 'view'), requestsController.getMyRequests);
router.get('/admin', ...protect('hr_requests', 'view'), requestsController.getAdminRequests);
router.get('/pending', ...protect('hr_requests', 'view'), requestsController.getPendingRequests);
router.get('/team', ...protect('hr_requests', 'view'), requestsController.getTeamRequests);
router.get('/team/:id', ...protect('hr_requests', 'view'), requestsController.getTeamRequestById);
router.patch(
  '/team/:id/status',
  ...protect('hr_requests', 'edit'),
  requestsController.updateTeamRequestStatus
);
router.get(
  '/attendance-correction/team',
  ...protect('hr_requests', 'view'),
  requestsController.getTeamAttendanceCorrectionRequests
);
router.get(
  '/attendance-correction/team/:id',
  ...protect('hr_requests', 'view'),
  requestsController.getTeamAttendanceCorrectionRequestById
);
router.patch(
  '/attendance-correction/team/:id/status',
  ...protect('hr_requests', 'edit'),
  requestsController.updateTeamAttendanceCorrectionStatus
);
router.patch('/:id/approve', ...protect('hr_requests', 'edit'), requestsController.approveRequest);
router.patch('/:id/reject', ...protect('hr_requests', 'edit'), requestsController.rejectRequest);
router.post('/:id/loan-payment', ...protect('hr_requests', 'edit'), financialController.recordLoanPayment);
router.post('/:id/loan-repayment', ...protect('hr_requests', 'edit'), financialController.recordEmployeeLoanPayment);
router.post('/:id/pf-payment', ...protect('provident_fund', 'edit'), financialController.recordPfPayment);
router.post('/:id/pf-repayment', ...protect('provident_fund', 'edit'), financialController.recordEmployeePfRepayment);
router.patch('/:id/pf-payout', ...protect('provident_fund', 'edit'), financialController.markPfPermanentPaid);
router.patch(
  '/:id/expense-reimbursement',
  ...protect('hr_requests', 'edit'),
  financialController.updateExpenseReimbursementStatus
);
router.patch('/:id', ...protect('hr_requests', 'edit'), requestsController.updateRequest);
router.patch('/:id/cancel', ...protect('hr_requests', 'edit'), requestsController.cancelRequest);

module.exports = router;
