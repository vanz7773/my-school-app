const DeviceActivityLog = require('../models/deviceActivityLog');

const MAX_STATIONARY_GAP_MINUTES = 35;

class DeviceMovementService {
  /**
   * Calculates continuous stationary duration (in minutes) for a teacher up to the given end time.
   * Uses the actual time gap between logs so throttled background tasks still count correctly.
   */
  async calculateStationaryDuration(teacherId, endTime) {
    const startOfDay = new Date(endTime);
    startOfDay.setHours(0, 0, 0, 0);

    const logs = await DeviceActivityLog.find({
      teacherId,
      timestamp: { $gte: startOfDay, $lte: endTime }
    }).sort({ timestamp: -1 }).lean();

    if (!logs.length) return 0;

    let stationaryMinutes = 0;
    let previousTimestamp = endTime;

    for (const log of logs) {
      const hasMovement = (log.steps || 0) > 0
        || !!log.tiltDetected
        || (log.movementLevel && log.movementLevel !== 'NONE');

      if (hasMovement) {
        break;
      }

      const logTimestamp = new Date(log.timestamp);
      const gapMinutes = Math.max(
        0,
        Math.round((previousTimestamp.getTime() - logTimestamp.getTime()) / 60000)
      );

      if (gapMinutes > MAX_STATIONARY_GAP_MINUTES) {
        break;
      }

      stationaryMinutes += gapMinutes;
      previousTimestamp = logTimestamp;
    }

    return stationaryMinutes;
  }
}

module.exports = new DeviceMovementService();
