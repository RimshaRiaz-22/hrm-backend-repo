const deviceTokenService = require('./deviceToken.service');
const fcmService = require('./fcm.service');

function normalizeNotificationContent(payload = {}) {
  const title = String(payload.title ?? payload.header ?? '').trim();
  const body = String(payload.body ?? payload.content ?? '').trim();

  return { title, body };
}

async function resolveTokensForUser(userId, deviceId) {
  if (!userId) {
    return [];
  }

  if (deviceId) {
    const deviceTokens = await deviceTokenService.getActiveTokensForUser(userId, { deviceId });
    if (deviceTokens.length > 0) {
      return deviceTokens;
    }
  }

  return deviceTokenService.getActiveTokensForUser(userId);
}

async function sendNotification({
  userId,
  deviceId = null,
  title,
  body,
  header,
  content,
  data = {},
  label = 'notification',
}) {
  const normalized = normalizeNotificationContent({ title, body, header, content });

  if (!userId) {
    return { sent: false, reason: 'userId is required.', label };
  }

  if (!normalized.title && !normalized.body) {
    return { sent: false, reason: 'Notification title or body is required.', label };
  }

  const tokens = await resolveTokensForUser(userId, deviceId);
  if (!tokens.length) {
    return {
      sent: false,
      reason: deviceId
        ? `No active FCM tokens found for user ${userId} on device ${deviceId}.`
        : `No active FCM tokens found for user ${userId}.`,
      label,
      successCount: 0,
      failureCount: 0,
      results: [],
    };
  }

  const payload = {
    title: normalized.title || 'HRM Notification',
    body: normalized.body || '',
    data: {
      ...data,
      label,
    },
  };

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const row of tokens) {
    const result = await fcmService.sendPushToToken(row.fcm_token, payload);
    results.push({
      token_id: row.id,
      platform: row.platform,
      device_id: row.device_id,
      ...result,
    });

    if (result.sent) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  return {
    sent: successCount > 0,
    reason: successCount > 0 ? null : results[0]?.reason || 'Failed to send notification.',
    label,
    successCount,
    failureCount,
    results,
  };
}

async function sendNotificationSafely(options) {
  const label = options?.label || 'notification';

  try {
    const result = await sendNotification(options);
    if (!result?.sent) {
      console.error(`Push notification (${label}) not sent: ${result?.reason || 'unknown error'}`);
    }
    return result;
  } catch (error) {
    console.error(`Push notification (${label}) error:`, error);
    return { sent: false, reason: error.message || 'Unexpected push notification error.', label };
  }
}

async function sendNotificationToEmployee(companyId, employeeId, notification) {
  const account = await deviceTokenService.getUserAccountByEmployeeId(companyId, employeeId);
  if (!account?.id) {
    console.error(`Push notification skipped: no active user for employee ${employeeId}`);
    return { sent: false, reason: 'Employee user account not found.' };
  }

  return sendNotificationSafely({
    ...notification,
    userId: account.id,
    deviceId: notification?.deviceId ?? account.device_id ?? null,
  });
}

async function sendNotificationToReviewers(companyId, reviewerUserAccounts, notification) {
  if (!reviewerUserAccounts?.length) {
    console.error(`Push notification skipped: no reviewer accounts for company ${companyId}`);
    return { sent: false, reason: 'No reviewer accounts found.' };
  }

  const results = await Promise.all(
    reviewerUserAccounts.map((account) =>
      sendNotificationSafely({
        ...notification,
        userId: account.id,
        deviceId: notification?.deviceId ?? account.device_id ?? null,
      })
    )
  );

  const successCount = results.filter((result) => result?.sent).length;

  return {
    sent: successCount > 0,
    successCount,
    failureCount: results.length - successCount,
    results,
  };
}

module.exports = {
  sendNotification,
  sendNotificationSafely,
  sendNotificationToEmployee,
  sendNotificationToReviewers,
};
