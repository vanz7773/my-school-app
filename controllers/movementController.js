const Movement = require('../models/movement');
const Teacher = require('../models/Teacher');
const Notification = require('../models/Notification');
const { broadcastNotification } = require('./notificationController');
const mongoose = require('mongoose');

// -------------------------------------------------------------------
// 🚀 Utility: Validate 12-hour time (AM/PM)
// -------------------------------------------------------------------
const timeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM)$/i;

// -------------------------------------------------------------------
// 🎯 Create a new movement (FAST + ATOMIC + CLEAN)
// -------------------------------------------------------------------
const createMovement = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid or missing user ID' });
    }

    // -------------------------------------------------------------------
    // 1️⃣ Fetch teacher once (lean = fast)
    // -------------------------------------------------------------------
    const teacher = await Teacher.findOne({ user: userId }).select('_id movements school').lean();

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher profile not found' });
    }

    const teacherId = teacher._id;

    // -------------------------------------------------------------------
    // 2️⃣ Validate input fields
    // -------------------------------------------------------------------
    const { name, destination, purpose, departureTime, arrivalTime } = req.body;

    const missing = [];
    if (!name) missing.push('name');
    if (!destination) missing.push('destination');
    if (!purpose) missing.push('purpose');
    if (!departureTime) missing.push('departureTime');
    if (!arrivalTime) missing.push('arrivalTime');

    if (missing.length) {
      return res.status(400).json({
        error: 'Missing required fields',
        fields: missing
      });
    }

    if (!timeRegex.test(departureTime) || !timeRegex.test(arrivalTime)) {
      return res.status(400).json({
        error: 'Invalid time format. Use "HH:MM AM/PM"',
        example: '09:30 AM'
      });
    }

    // -------------------------------------------------------------------
    // 3️⃣ Rate limit (1-hour window)
    // -------------------------------------------------------------------
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentCount = await Movement.countDocuments({
      teacher: teacherId,
      createdAt: { $gte: oneHourAgo }
    });

    if (recentCount > 5) {
      return res.status(429).json({
        error: 'Too many submissions. Try again later.'
      });
    }

    // -------------------------------------------------------------------
    // 4️⃣ Run atomic transaction (movement + teacher update)
    // -------------------------------------------------------------------
    const session = await mongoose.startSession();
    session.startTransaction();

    const movement = await Movement.create([{
      name,
      destination,
      purpose,
      departureTime,
      arrivalTime,
      teacher: teacherId,
      school: teacher.school
    }], { session });

    await Teacher.updateOne(
      { _id: teacherId },
      { $push: { movements: movement[0]._id } },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // -------------------------------------------------------------------
    // 6️⃣ Send Notification to Admins (Fire and forget, don't block response)
    // -------------------------------------------------------------------
    (async () => {
      try {
        const notif = await Notification.create({
          title: 'New Teacher Movement',
          message: `${name} has recorded a new movement to ${destination}.`,
          type: 'teacher-attendance',
          audience: 'admin',
          school: teacher.school,
          sender: userId,
          relatedResource: movement[0]._id,
          resourceModel: 'Movement' // Note: Ensure this is in the enum if strictly validated
        });

        // Mock req for broadcastNotification
        const mockReq = {
          app: req.app,
          user: req.user
        };
        await broadcastNotification(mockReq, notif);
      } catch (nErr) {
        console.error('Movement notification failed:', nErr);
      }
    })();

    return res.status(201).json({
      message: 'Movement recorded successfully.',
      movement: {
        ...movement[0]._doc,
        teacher: { _id: teacherId }
      }
    });

  } catch (error) {
    console.error('Movement create error:', error);

    return res.status(500).json({
      error: 'Failed to record movement',
      details: error.message
    });
  }
};

// -------------------------------------------------------------------
// 📌 Get all movements for logged-in teacher
// -------------------------------------------------------------------
const getTeacherMovements = async (req, res) => {
  try {
    const userId = req.user?._id;

    const teacher = await Teacher.findOne({ user: userId }).select('_id').lean();
    if (!teacher) {
      return res.status(404).json({ error: 'Teacher profile not found' });
    }

    const movements = await Movement.find({ teacher: teacher._id })
      .select('name destination purpose departureTime arrivalTime date')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ movements });

  } catch (error) {
    console.error('Fetch teacher movements failed:', error);
    return res.status(500).json({ error: 'Failed to fetch movements' });
  }
};

// -------------------------------------------------------------------
// 📌 Admin: Get all movements
// -------------------------------------------------------------------
const getAllMovements = async (req, res) => {
  try {
    const schoolId = req.user?.school;

    if (!schoolId) {
      return res.status(400).json({ error: 'School context missing' });
    }

    // 1️⃣ Fetch all teacher IDs for this school (to include legacy movements without school field)
    const teachersList = await Teacher.find({ school: schoolId }).select('_id').lean();
    const teacherIds = teachersList.map(t => t._id);

    // 2️⃣ Query movements belonging to this school or these teachers
    const movements = await Movement.find({
      $or: [
        { school: schoolId },
        { teacher: { $in: teacherIds } }
      ]
    })
      .populate({
        path: 'teacher',
        select: 'user',
        populate: { path: 'user', select: 'name' }
      })
      .sort({ createdAt: -1 })
      .lean();

    // Map to flatten teacher name for easy frontend use
    const formattedMovements = movements.map(m => ({
      ...m,
      teacherName: m.teacher?.user?.name || 'Unknown Teacher'
    }));

    return res.status(200).json({ movements: formattedMovements });

  } catch (error) {
    console.error('Fetch all movements failed:', error);
    return res.status(500).json({ error: 'Failed to fetch movements' });
  }
};

module.exports = {
  createMovement,
  getTeacherMovements,
  getAllMovements
};
