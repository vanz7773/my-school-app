const nodeCron = require('node-cron');
const pointInPolygon = require('point-in-polygon');
const DeviceActivityLog = require('../models/deviceActivityLog');
const DeviceAlert = require('../models/deviceAlert');
const DeviceMovementService = require('../services/deviceMovementService');
const InternetMonitoringService = require('../services/internetMonitoringService');
const MovementScoreService = require('../services/movementScoreService');
const User = require('../models/User');
const School = require('../models/School');

class DeviceMonitoringJob {
  constructor() {
    this.isJobRunning = false;
  }

  isWithinWorkingHours(date = new Date()) {
    const hour = date.getHours();
    return hour >= 7 && hour < 15;
  }

  start() {
    nodeCron.schedule('*/15 * * * *', async () => {
      if (!this.isWithinWorkingHours()) return;
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
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const distinctTeachers = await DeviceActivityLog.distinct('teacherId', {
      timestamp: { $gte: startOfDay, $lte: now }
    });

    for (const teacherId of distinctTeachers) {
      try {
        // 1. GEOFENCE CHECK
        const latestLog = await DeviceActivityLog.findOne({
          teacherId,
          timestamp: { $gte: startOfDay, $lte: now }
        }).sort({ timestamp: -1 });

        if (
          latestLog
          && latestLog.location
          && latestLog.location.latitude != null
          && latestLog.location.longitude != null
        ) {
          const user = await User.findById(teacherId).select('school');
          if (user && user.school) {
            const school = await School.findById(user.school).select('location');
            if (school && school.location && school.location.coordinates && school.location.coordinates.length > 0) {
              const polygon = school.location.coordinates[0]; // [[lng, lat]]
              const isInside = pointInPolygon([latestLog.location.longitude, latestLog.location.latitude], polygon);
              
              if (!isInside) {
                const recentOobAlert = await DeviceAlert.findOne({
                  teacherId,
                  alertType: 'Out of Bounds (During Working Hours)',
                  timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) }
                });

                if (!recentOobAlert) {
                  await DeviceAlert.create({
                    teacherId,
                    alertType: 'Out of Bounds (During Working Hours)',
                    movementScore: 'N/A'
                  });
                }
              }
            }
          }
        }

        // 2. STATIONARY CHECK
        const stationaryMin = await DeviceMovementService.calculateStationaryDuration(teacherId, now);
        if (stationaryMin >= 90) {
          const recentAlert = await DeviceAlert.findOne({
            teacherId,
            alertType: { $in: ['Device inactive for 2 hours', 'Possible phone abandonment'] },
            timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) }
          });

          if (!recentAlert) {
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

        // 3. OFFLINE CHECK
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
              movementScore: 'N/A'
            });
          }
        }
      } catch (teacherErr) {
        console.error(`Error during device monitoring analysis for teacher ${teacherId}:`, teacherErr);
      }
    }
  }
}

module.exports = new DeviceMonitoringJob();
