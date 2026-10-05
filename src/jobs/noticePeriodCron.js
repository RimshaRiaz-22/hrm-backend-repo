const cron = require('node-cron');
const {
  processNoticePeriodsDaily,
  ensureNoticePeriodsProcessed,
} = require('../services/noticePeriod.service');

let scheduledTask = null;

function startNoticePeriodCron() {
  if (scheduledTask) return scheduledTask;

  void ensureNoticePeriodsProcessed({ force: true }).catch((error) => {
    console.error('[notice-period-cron] startup sync failed:', error.message);
  });

  // Run daily at 00:05 UTC
  scheduledTask = cron.schedule('5 0 * * *', async () => {
    console.log('[notice-period-cron] starting daily notice period check');
    try {
      await processNoticePeriodsDaily();
      console.log('[notice-period-cron] completed');
    } catch (error) {
      console.error('[notice-period-cron] failed:', error.message);
    }
  });

  return scheduledTask;
}

module.exports = {
  startNoticePeriodCron,
};
