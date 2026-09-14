const express = require('express');
const employeeOnboardingController = require('../controllers/employeeOnboarding.controller');
const { protect } = require('../middleware/routeProtection');
const { requireOnboardingToken } = require('../middleware/onboardingAuth.middleware');

const router = express.Router();

// Employee self-service — authenticated via the emailed onboarding token, not a login session.
router.get('/me', requireOnboardingToken, employeeOnboardingController.getMyOnboardingProfile);
router.get('/me/religions', requireOnboardingToken, employeeOnboardingController.listMyOnboardingReligions);
router.get(
  '/me/relationship-options',
  requireOnboardingToken,
  employeeOnboardingController.listMyOnboardingRelationshipOptions
);
router.post(
  '/me/relationship-types',
  requireOnboardingToken,
  employeeOnboardingController.createMyOnboardingRelationshipType
);
router.patch('/me', requireOnboardingToken, employeeOnboardingController.updateMyOnboardingProfile);
router.post('/me/documents', requireOnboardingToken, employeeOnboardingController.upsertMyOnboardingDocument);
router.post('/me/dependants', requireOnboardingToken, employeeOnboardingController.setMyOnboardingDependants);
router.post('/me/submit', requireOnboardingToken, employeeOnboardingController.submitMyOnboardingProfile);
// No requireOnboardingToken here on purpose — this exists specifically for an already-expired
// token, which requireOnboardingToken would reject outright. The controller verifies the same
// token's signature/purpose itself, ignoring the exp claim, just to identify who's asking.
router.post('/me/request-resend', employeeOnboardingController.requestOnboardingInviteResend);

// Company Admin / HR — invite, review, and activate new hires.
// Listing lives on the existing GET /api/v1/employees (onboarding_status is included there);
// this router only covers the invite/review/activate actions plus the per-employee submission detail.
router.post('/invite', ...protect('employees', 'add'), employeeOnboardingController.inviteEmployee);
router.get('/:employeeId', ...protect('employees', 'view'), employeeOnboardingController.getOnboardingEmployeeById);
router.post(
  '/:employeeId/resend',
  ...protect('employees', 'add'),
  employeeOnboardingController.resendOnboardingInvite
);
router.patch(
  '/:employeeId/documents/:documentId',
  ...protect('employees', 'edit'),
  employeeOnboardingController.reviewOnboardingDocument
);
router.post(
  '/:employeeId/activate',
  ...protect('employees', 'edit'),
  employeeOnboardingController.activateOnboardingEmployee
);

module.exports = router;
