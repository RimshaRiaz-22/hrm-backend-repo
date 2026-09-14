const cron = require('node-cron');
const { processDueAnniversaryNotifications } = require('../services/anniversaryNotification.service');

let scheduledTask = null;

function startAnniversaryNotificationCron() {
  if (scheduledTask) return scheduledTask;

  // Runs every 15 min; each employee is only processed during their own local midnight window
  // (see wallClockMinutesInTimezone / work-location or company timezone) so this covers every timezone.
  scheduledTask = cron.schedule('*/15 * * * *', async () => {
    try {
      await processDueAnniversaryNotifications();
    } catch (error) {
      console.error('[anniversary-notification-cron] failed:', error.message);
    }
  });

  return scheduledTask;
}

module.exports = {
  startAnniversaryNotificationCron,
};
