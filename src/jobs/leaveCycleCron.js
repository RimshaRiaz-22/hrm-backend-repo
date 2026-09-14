const cron = require('node-cron');
const { processLeaveCycleRenewals } = require('../services/leaveCycle.service');

let scheduledTask = null;

function startLeaveCycleCron() {
  if (scheduledTask) return scheduledTask;

  void processLeaveCycleRenewals({ force: true }).catch((error) => {
    console.error('[leave-cycle-cron] startup sync failed:', error.message);
  });

  // Run daily at 00:10 UTC (after notice-period cron at 00:05)
  scheduledTask = cron.schedule('10 0 * * *', async () => {
    console.log('[leave-cycle-cron] starting daily leave cycle renewal');
    try {
      await processLeaveCycleRenewals({ force: true });
      console.log('[leave-cycle-cron] completed');
    } catch (error) {
      console.error('[leave-cycle-cron] failed:', error.message);
    }
  });

  return scheduledTask;
}

module.exports = {
  startLeaveCycleCron,
};
