const express = require('express');
const deviceTokenController = require('../controllers/deviceToken.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/fcm-tokens', ...protect('devices', 'view'), deviceTokenController.listMyFcmTokens);
router.put('/fcm-token', ...protect('devices', 'add'), deviceTokenController.registerFcmToken);
router.delete('/fcm-token', ...protect('devices', 'delete'), deviceTokenController.unregisterFcmToken);
router.post('/fcm-test', ...protect('devices', 'add'), deviceTokenController.sendTestFcmNotification);

module.exports = router;
