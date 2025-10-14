const schedule = require('node-schedule');

function scheduleDailyReset(resetCallback) {
  schedule.scheduleJob({ hour: 0, minute: 0, tz: 'Etc/UTC' }, async () => {
    try {
      await resetCallback();
    } catch (error) {
      console.error('Erreur lors de la réinitialisation quotidienne:', error.message);
    }
  });
}

module.exports = {
  scheduleDailyReset,
};
