const cron = require('node-cron');
const { processDueBirthdayNotifications } = require('../services/birthdayNotification.service');

let scheduledTask = null;

function startBirthdayNotificationCron() {
  if (scheduledTask) return scheduledTask;

  // Runs every 15 min; each company is only processed during its own local midnight window
  // (see wallClockMinutesInTimezone / companies.timezone) so this covers every timezone, not just UTC.
  scheduledTask = cron.schedule('*/15 * * * *', async () => {
    try {
      await processDueBirthdayNotifications();
    } catch (error) {
      console.error('[birthday-notification-cron] failed:', error.message);
    }
  });

  return scheduledTask;
}

module.exports = {
  startBirthdayNotificationCron,
};
