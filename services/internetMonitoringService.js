const DeviceActivityLog = require('../models/deviceActivityLog');

class InternetMonitoringService {
  /**
   * Calculates continuous offline duration (in minutes) for a teacher up to the given end time.
   */
  async calculateOfflineDuration(teacherId, endTime) {
    // Fetch logs for today up to endTime, sorted descending by time
    const startOfDay = new Date(endTime);
    startOfDay.setHours(0, 0, 0, 0);

    const logs = await DeviceActivityLog.find({
      teacherId,
      timestamp: { $gte: startOfDay, $lte: endTime }
    }).sort({ timestamp: -1 });

    if (!logs.length) return 0;

    let offlineMinutes = 0;

    for (const log of logs) {
      if (log.internetStatus === 'online') {
        break; // Restored online status breaks the offline chain
      }
      
      // Each offline log typically represents a 5-minute offline sampling window (since it synced later)
      // or we can calculate the explicit delta between the first offline log and current.
      offlineMinutes += 5;
    }

    return offlineMinutes;
  }
}

module.exports = new InternetMonitoringService();
