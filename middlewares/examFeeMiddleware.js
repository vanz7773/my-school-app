const School = require('../models/School');
exports.requireExamFees = async (req, res, next) => {
  try {
    if (!req.user?.school || !await School.exists({ _id: req.user.school, 'features.examFeesEnabled': true })) {
      return res.status(403).json({ success: false, message: 'Exam Fees are disabled for this school.' });
    }
    next();
  } catch (error) {
    console.error('Exam fee feature check failed:', error.message);
    res.status(500).json({ success: false, message: 'Unable to check exam fee availability.' });
  }
};
