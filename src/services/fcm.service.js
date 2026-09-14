const admin = require('firebase-admin');
const { getMessaging: getFirebaseMessaging } = require('firebase-admin/messaging');
const { getFirebaseConfig } = require('../config/firebase.config');
const deviceTokenService = require('./deviceToken.service');

let firebaseApp = null;

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

function getFirebaseSetupStatus() {
  const config = getFirebaseConfig();
  return {
    configured: config.configured,
    project_id: config.projectId,
    google_services_path: config.googleServicesPath,
    service_account_path: config.serviceAccountPath,
    android_package_name: config.androidPackageName,
    setup_error: config.setupError,
  };
}

function isFcmConfigured() {
  return getFirebaseConfig().configured;
}

function getFirebaseApp() {
  if (firebaseApp) {
    return firebaseApp;
  }

  const config = getFirebaseConfig();
  if (!config.configured) {
    return null;
  }

  if (admin.getApps().length > 0) {
    firebaseApp = admin.getApp();
    return firebaseApp;
  }

  if (config.serviceAccount) {
    firebaseApp = admin.initializeApp({
      credential: admin.cert(config.serviceAccount),
      projectId: config.projectId || config.serviceAccount.project_id,
    });
    return firebaseApp;
  }

  if (config.inlineServiceAccount) {
    firebaseApp = admin.initializeApp({
      credential: admin.cert({
        projectId: config.inlineServiceAccount.projectId,
        clientEmail: config.inlineServiceAccount.clientEmail,
        privateKey: config.inlineServiceAccount.privateKey,
      }),
      projectId: config.projectId || config.inlineServiceAccount.projectId,
    });
    return firebaseApp;
  }

  return null;
}

function getMessaging() {
  const app = getFirebaseApp();
  if (!app) {
    return null;
  }
  return getFirebaseMessaging(app);
}

function buildMessage(token, payload = {}) {
  const title = String(payload.title ?? payload.header ?? '').trim();
  const body = String(payload.body ?? payload.content ?? '').trim();
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

  const stringData = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [String(key), String(value ?? '')])
  );

  return {
    token,
    notification: title || body ? { title: title || 'Notification', body: body || '' } : undefined,
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        channelId: 'hrm_default',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };
}

async function handleSendError(error, token) {
  const code = error?.code || error?.errorInfo?.code || null;
  if (code && INVALID_TOKEN_CODES.has(code)) {
    await deviceTokenService.deactivateToken(token);
  }

  return {
    sent: false,
    reason: error?.message || 'Failed to send FCM notification.',
    code,
  };
}

async function sendPushToToken(token, payload = {}) {
  const fcmToken = String(token || '').trim();
  if (!fcmToken) {
    return { sent: false, reason: 'FCM token is required.' };
  }

  const setup = getFirebaseSetupStatus();
  if (!setup.configured) {
    return {
      sent: false,
      reason: setup.setup_error || 'FCM is not configured.',
    };
  }

  const messaging = getMessaging();
  if (!messaging) {
    return { sent: false, reason: 'FCM is not configured.' };
  }

  try {
    const message = buildMessage(fcmToken, payload);
    const messageId = await messaging.send(message);
    await deviceTokenService.touchTokenLastUsed(fcmToken);

    return {
      sent: true,
      messageId,
    };
  } catch (error) {
    return handleSendError(error, fcmToken);
  }
}

module.exports = {
  getFirebaseSetupStatus,
  isFcmConfigured,
  sendPushToToken,
};
