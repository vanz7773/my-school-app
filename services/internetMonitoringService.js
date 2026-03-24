const DeviceActivityLog = require('../models/deviceActivityLog');

class InternetMonitoringService {
  /**
   * Calculates continuous offline duration (in minutes) for a teacher up to the given end time.
   */
  async calculateOfflineDuration(teacherId, endTime) {
    // If the device's internet is off, it CANNOT send logs to the server.
    // Thus, measuring "offline" means measuring the gap since the last received log heartbeat.
    const latestLog = await DeviceActivityLog.findOne({
      teacherId,
      timestamp: { $lte: endTime }
    }).sort({ timestamp: -1 });

    if (!latestLog) return 0; // If they have never sent a log, they haven't clocked in

    // Calculate minutes since the last ping
    const diffMs = endTime.getTime() - new Date(latestLog.timestamp).getTime();
    const diffMins = Math.floor(diffMs / 60000);

    return diffMins;
  }
}

module.exports = new InternetMonitoringService();
