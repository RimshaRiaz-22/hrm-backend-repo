
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pushNotificationService = require('../src/services/pushNotification.service');
const fcmService = require('../src/services/fcm.service');
const pool = require('../src/db');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--user-id') {
      args.userId = Number(value);
      i += 1;
    } else if (key === '--token') {
      args.token = value;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { userId, token } = parseArgs(process.argv);

  if (!fcmService.isFcmConfigured()) {
    throw new Error('FCM is not configured. Set FIREBASE_* env vars or GOOGLE_APPLICATION_CREDENTIALS.');
  }

  let result;
  if (token) {
    result = await fcmService.sendPushToToken(token, {
      title: 'HRM Test Notification',
      body: 'FCM CLI test succeeded.',
      data: {
        type: 'test',
        screen: 'Home',
        sent_at: new Date().toISOString(),
      },
    });
  } else if (userId) {
    result = await pushNotificationService.sendNotification({
      userId,
      title: 'HRM Test Notification',
      body: 'FCM CLI test succeeded.',
      data: {
        type: 'test',
        screen: 'Home',
        sent_at: new Date().toISOString(),
      },
      label: 'test',
    });
  } else {
    throw new Error('Provide --user-id <id> or --token "<fcm_token>".');
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.sent) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
