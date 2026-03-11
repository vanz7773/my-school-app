const DeviceActivityLog = require('../models/deviceActivityLog');

class DeviceMovementService {
  /**
   * Calculates continuous stationary duration (in minutes) for a teacher up to the given end time.
   * Assumes logs are submitted every ~5 mins during working hours.
   */
  async calculateStationaryDuration(teacherId, endTime) {
    // Fetch logs for today up to endTime, sorted descending by time
    const startOfDay = new Date(endTime);
    startOfDay.setHours(0, 0, 0, 0);

    const logs = await DeviceActivityLog.find({
      teacherId,
      timestamp: { $gte: startOfDay, $lte: endTime }
    }).sort({ timestamp: -1 });

    if (!logs.length) return 0;

    let stationaryMinutes = 0;

    for (const log of logs) {
      // If the device registered any steps or tilt, or level wasn't NONE, it broke the stationary chain
      if (log.steps > 0 || log.tiltDetected || log.movementLevel !== 'NONE') {
        break; // Stop counting backwards
      }
      
      // Each stationary log usually represents a 5-minute sampling window
      stationaryMinutes += 5;
    }

    return stationaryMinutes;
  }
}

module.exports = new DeviceMovementService();
