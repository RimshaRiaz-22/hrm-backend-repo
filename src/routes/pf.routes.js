const express = require('express');
const pfController = require('../controllers/pf.controller');
const { protect, withPermissions } = require('../middleware/routeProtection');

const router = express.Router();

// Self-service: any authenticated employee can view/preview their own PF account.
router.get('/balance/me', ...withPermissions(), pfController.getMyBalance);
router.post('/temporary/preview', ...withPermissions(), pfController.previewPfTemporary);
router.post('/permanent/preview', ...withPermissions(), pfController.previewPfPermanent);
router.get('/recoveries/me', ...withPermissions(), pfController.listMyRecoveries);

router.get('/accounts', ...protect('provident_fund', 'view'), pfController.listAccounts);
router.post('/accounts/enroll', ...protect('provident_fund', 'add'), pfController.enrollAccount);
router.patch('/accounts/:employeeId/rates', ...protect('provident_fund', 'edit'), pfController.updateAccountRates);
router.post('/contributions/process', ...protect('provident_fund', 'add'), pfController.processContributions);

router.get('/balance/:employeeId', ...protect('provident_fund', 'view'), pfController.getEmployeeBalance);
router.get('/recoveries', ...protect('provident_fund', 'view'), pfController.listRecoveries);
router.get('/recoveries/:id', ...protect('provident_fund', 'view'), pfController.getRecovery);

module.exports = router;
