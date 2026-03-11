const nodeCron = require('node-cron');
const DeviceActivityLog = require('../models/deviceActivityLog');
const DeviceAlert = require('../models/deviceAlert');
const DeviceMovementService = require('../services/deviceMovementService');
const InternetMonitoringService = require('../services/internetMonitoringService');
const MovementScoreService = require('../services/movementScoreService');

class DeviceMonitoringJob {
  constructor() {
    this.isJobRunning = false;
  }

  // Define the working hours constraint
  isWithinWorkingHours(date = new Date()) {
    const hour = date.getHours();
    // 07:00 to 14:59 (15:00 is end)
    return hour >= 7 && hour < 15;
  }

  start() {
    // Run every 15 minutes
    nodeCron.schedule('*/15 * * * *', async () => {
      // Only process during working hours
      if (!this.isWithinWorkingHours()) {
        return;
      }

      if (this.isJobRunning) {
        console.log('Skipping device monitoring job, previous run still in progress.');
        return;
      }

      this.isJobRunning = true;
      try {
        await this.runAnalysis();
      } catch (err) {
        console.error('Error running device monitoring job:', err);
      } finally {
        this.isJobRunning = false;
      }
    });

    console.log('Device Monitoring Job scheduled.');
  }

  async runAnalysis() {
    const now = new Date();
    // 1. Get all distinct active teachers who synced logs today
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const distinctTeachers = await DeviceActivityLog.distinct('teacherId', {
      timestamp: { $gte: startOfDay, $lte: now }
    });

    for (const teacherId of distinctTeachers) {
      // Check for 90-min stationary duration
      const stationaryMin = await DeviceMovementService.calculateStationaryDuration(teacherId, now);
      if (stationaryMin >= 90) {
        // Prevent duplicate alerts within a 1-hour window
        const recentAlert = await DeviceAlert.findOne({
          teacherId,
          alertType: { $in: ['Device inactive for 2 hours', 'Possible phone abandonment'] },
          timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) }
        });

        if (!recentAlert) {
          // Fetch logs for the past hour to calculate score
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
          const hourlyLogs = await DeviceActivityLog.find({
            teacherId,
            timestamp: { $gte: oneHourAgo, $lte: now }
          });
          const score = MovementScoreService.calculateScore(hourlyLogs);

          await DeviceAlert.create({
            teacherId,
            alertType: stationaryMin >= 120 ? 'Device inactive for 2 hours' : 'Possible phone abandonment',
            stationaryDuration: stationaryMin,
            movementScore: score
          });
        }
      }

      // Check for 60-min internet offline duration
      const offlineMin = await InternetMonitoringService.calculateOfflineDuration(teacherId, now);
      if (offlineMin >= 60) {
        const recentOfflineAlert = await DeviceAlert.findOne({
          teacherId,
          alertType: 'Internet disabled during working hours',
          timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) }
        });

        if (!recentOfflineAlert) {
          await DeviceAlert.create({
            teacherId,
            alertType: 'Internet disabled during working hours',
            offlineDuration: offlineMin,
            movementScore: 'N/A' // Score isn't usually evaluated for an offline alert
          });
        }
      }
    }
  }
}

module.exports = new DeviceMonitoringJob();
