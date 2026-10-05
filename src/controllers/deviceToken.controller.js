const { sendSuccess, sendError } = require('../utils/apiResponse');
const deviceTokenService = require('../services/deviceToken.service');
const fcmService = require('../services/fcm.service');
const pushNotificationService = require('../services/pushNotification.service');

function handleServiceResult(res, result, successMessage, successStatus = 200) {
  if (result.error) {
    return sendError(res, result.status || 400, result.error);
  }
  return sendSuccess(res, successStatus, successMessage, result.data);
}

async function registerFcmToken(req, res) {
  try {
    const result = await deviceTokenService.registerDeviceToken(req.authUser.userId, req.body);
    return handleServiceResult(res, result, 'FCM token registered successfully.', 200);
  } catch (error) {
    console.error('Register FCM token error:', error);
    return sendError(res, 500, 'Something went wrong while registering the FCM token.');
  }
}

async function unregisterFcmToken(req, res) {
  try {
    const result = await deviceTokenService.unregisterDeviceToken(req.authUser.userId, req.body);
    return handleServiceResult(res, result, 'FCM token unregistered successfully.');
  } catch (error) {
    console.error('Unregister FCM token error:', error);
    return sendError(res, 500, 'Something went wrong while unregistering the FCM token.');
  }
}

async function listMyFcmTokens(req, res) {
  try {
    const tokens = await deviceTokenService.getActiveTokensForUser(req.authUser.userId);
    const fcmStatus = fcmService.getFirebaseSetupStatus();
    return sendSuccess(res, 200, 'FCM tokens fetched successfully.', {
      tokens: tokens.map((row) => ({
        id: row.id,
        platform: row.platform,
        device_id: row.device_id,
        device_label: row.device_label,
        last_used_at: row.last_used_at,
      })),
      fcm: fcmStatus,
    });
  } catch (error) {
    console.error('List FCM tokens error:', error);
    return sendError(res, 500, 'Something went wrong while fetching FCM tokens.');
  }
}

async function sendTestFcmNotification(req, res) {
  try {
    const result = await pushNotificationService.sendNotification({
      userId: req.authUser.userId,
      deviceId: req.body?.device_id ?? req.body?.deviceId ?? null,
      title: req.body?.title ?? req.body?.header ?? 'HRM Test Notification',
      body: req.body?.body ?? req.body?.content ?? 'FCM is working. You should see this on your device.',
      data: {
        type: 'test',
        screen: 'Home',
        sent_at: new Date().toISOString(),
      },
      label: 'test',
    });

    if (!result.sent) {
      const fcmStatus = fcmService.getFirebaseSetupStatus();
      return sendError(res, 400, result.reason || 'Failed to send test notification.', {
        fcm: fcmStatus,
        success_count: result.successCount ?? 0,
        failure_count: result.failureCount ?? 0,
        results: result.results ?? [],
      });
    }

    return sendSuccess(res, 200, 'Test notification sent successfully.', {
      success_count: result.successCount,
      failure_count: result.failureCount,
      results: result.results,
    });
  } catch (error) {
    console.error('Send test FCM notification error:', error);
    return sendError(res, 500, 'Something went wrong while sending the test notification.');
  }
}

module.exports = {
  registerFcmToken,
  unregisterFcmToken,
  listMyFcmTokens,
  sendTestFcmNotification,
};
