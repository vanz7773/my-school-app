class MovementScoreService {
  /**
   * Calculates a movement score category based on steps and tilt changes 
   * over a given sequence of logs (e.g. hourly)
   */
  calculateScore(logs) {
    if (!logs || logs.length === 0) return 'N/A';
    
    let totalSteps = 0;
    let tiltChanges = 0;
    let motionEvents = 0;
    
    logs.forEach(log => {
      totalSteps += (log.steps || 0);
      if (log.tiltDetected) tiltChanges++;
      if (log.movementLevel !== 'NONE') motionEvents++;
    });

    const score = totalSteps + tiltChanges + motionEvents;

    if (score <= 5) return 'VERY_LOW';
    if (score <= 20) return 'NORMAL';
    return 'HIGH';
  }
}

module.exports = new MovementScoreService();
