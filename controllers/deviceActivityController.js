const DeviceActivityLog = require('../models/deviceActivityLog');
const DeviceAlert = require('../models/deviceAlert');
const DeviceMovementService = require('../services/deviceMovementService');

exports.syncLogs = async (req, res) => {
  try {
    const { logs } = req.body;
    
    // In our app, typically `req.user` contains the authenticated user (teacher/admin)
    // If not, we expect teacherId to be parsed from the token. Adjust based on existing auth middleware
    const teacherId = req.user._id || req.body.teacherId; 

    if (!teacherId || !logs || !Array.isArray(logs)) {
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    // Attach teacherId to logs
    const logsToInsert = logs.map(log => ({
      ...log,
      teacherId
    }));

    await DeviceActivityLog.insertMany(logsToInsert);
    
    // 🔐 GEOFENCE ALERT CHECK: Trigger real-time alert if violation detected
    const geofenceViolationLog = logs.find(l => l.geofenceViolation === true);
    if (geofenceViolationLog) {
      // Check if we already created a Geofence alert in the last hour to prevent spam
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentAlert = await DeviceAlert.findOne({
        teacherId,
        alertType: 'Out of Bounds (During Working Hours)',
        timestamp: { $gte: oneHourAgo }
      });

      if (!recentAlert) {
        await DeviceAlert.create({
          teacherId,
          alertType: 'Out of Bounds (During Working Hours)',
          timestamp: geofenceViolationLog.timestamp || new Date(),
          movementScore: 'N/A'
        });
      }
    }

    // Existing suspicion verification check
    const isVerificationEvent = logs.some(l => l.verificationCompleted);
    if (isVerificationEvent) {
       const stationaryMin = await DeviceMovementService.calculateStationaryDuration(teacherId, new Date());
       if (stationaryMin >= 120) {
         await DeviceAlert.create({
            teacherId,
            alertType: 'Suspicious verification detected',
            stationaryDuration: stationaryMin,
            movementScore: 'N/A'
         });
       }
    }

    res.status(200).json({ success: true, message: 'Logs synced successfully' });
  } catch (error) {
    console.error('Error syncing device logs:', error);
    res.status(500).json({ success: false, message: 'Server error parsing device logs' });
  }
};

exports.getAlerts = async (req, res) => {
  try {
    const alerts = await DeviceAlert.find({ isReviewed: false })
      .populate('teacherId', 'name email role')
      .sort({ timestamp: -1 })
      .limit(100);

    res.status(200).json({ success: true, alerts });
  } catch (error) {
    console.error('Error fetching device alerts:', error);
    res.status(500).json({ success: false, message: 'Server error fetching alerts' });
  }
};

exports.getOverview = async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    // Get active teachers who synced logs today
    const distinctTeachers = await DeviceActivityLog.distinct('teacherId', {
      timestamp: { $gte: startOfDay, $lte: now }
    });

    const activeTeacherCount = distinctTeachers.length;
    
    // Get unreviewed alerts count today
    const activeAlertsCount = await DeviceAlert.countDocuments({
      isReviewed: false,
      timestamp: { $gte: startOfDay, $lte: now }
    });

    // We will compute internet disabled / stationary count manually or via aggregation
    let internetDisabledCount = 0;
    let stationaryCount = 0;
    
    // Array of objects holding a summary per teacher
    const teachersList = [];
    
    const User = require('../models/User'); // Used to populate the teacher's name
    // (Assuming User model exists, otherwise modify according to codebase)
    
    for (const teacherId of distinctTeachers) {
      const user = await User.findById(teacherId).select('name email');
      if (!user) continue;

      // get latest log
      const latestLog = await DeviceActivityLog.findOne({ teacherId }).sort({ timestamp: -1 });
      
      const stationaryMin = await DeviceMovementService.calculateStationaryDuration(teacherId, now);
      
      // Need InternetMonitoringService & MovementScoreService linked
      const InternetMonitoringService = require('../services/internetMonitoringService');
      const MovementScoreService = require('../services/movementScoreService');
      
      const offlineMin = await InternetMonitoringService.calculateOfflineDuration(teacherId, now);
      
      // Hourly logs for movement score
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const hourlyLogs = await DeviceActivityLog.find({
        teacherId,
        timestamp: { $gte: oneHourAgo, $lte: now }
      });
      const score = MovementScoreService.calculateScore(hourlyLogs);
      
      // See if they have any active unreviewed alerts
      const hasAlerts = await DeviceAlert.exists({ teacherId, isReviewed: false });

      if (offlineMin >= 60) internetDisabledCount++;
      if (stationaryMin >= 90) stationaryCount++;

      teachersList.push({
        _id: teacherId,
        name: user.name,
        email: user.email,
        status: (offlineMin >= 60 || stationaryMin >= 90) ? 'Suspicious' : 'Active',
        movementScore: score,
        stationaryTime: stationaryMin, // explicitly send mins
        internetStatus: latestLog?.internetStatus || 'online',
        hasAlerts: !!hasAlerts,
        lastSeen: latestLog?.timestamp
      });
    }

    res.status(200).json({
      success: true,
      stats: {
        teachersMonitored: activeTeacherCount,
        deviceAlerts: activeAlertsCount,
        internetDisabled: internetDisabledCount,
        stationaryDevices: stationaryCount
      },
      teachers: teachersList
    });
  } catch (error) {
    console.error('Error fetching device overview:', error);
    res.status(500).json({ success: false, message: 'Server error fetching overview' });
  }
};

exports.getTeacherLogs = async (req, res) => {
  try {
    const { id: teacherId } = req.params;
    
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const logs = await DeviceActivityLog.find({
      teacherId,
      timestamp: { $gte: startOfDay, $lte: now }
    }).sort({ timestamp: 1 }); // Chronological

    res.status(200).json({ success: true, logs });
  } catch (error) {
    console.error('Error fetching teacher logs:', error);
    res.status(500).json({ success: false, message: 'Server error fetching teacher logs' });
  }
};

exports.reviewAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const alert = await DeviceAlert.findById(id);
    
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    alert.isReviewed = true;
    await alert.save();

    res.status(200).json({ success: true, message: 'Alert marked as reviewed' });
  } catch (error) {
    console.error('Error reviewing alert:', error);
    res.status(500).json({ success: false, message: 'Server error reviewing alert' });
  }
};
