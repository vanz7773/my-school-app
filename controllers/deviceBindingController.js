// controllers/deviceBindingController.js
const DeviceBinding = require('../models/DeviceBinding');
const Teacher = require('../models/Teacher');

/**
 * Admin override: rebind a teacher's device
 */
exports.rebindDevice = async (req, res) => {
  try {
    const { teacherId, newDeviceUUID } = req.body;

    if (!teacherId || !newDeviceUUID) {
      return res.status(400).json({ status: 'fail', message: 'Teacher ID and new device UUID are required.' });
    }

    // Ensure teacher exists
    const teacher = await Teacher.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ status: 'fail', message: 'Teacher not found.' });
    }

    // Remove old binding if exists
    await DeviceBinding.findOneAndDelete({ teacher: teacher._id });

    // Also ensure no other teacher has this device
    await DeviceBinding.findOneAndDelete({ deviceUUID: newDeviceUUID });

    // Create new binding
    const binding = await DeviceBinding.create({
      teacher: teacher._id,
      deviceUUID: newDeviceUUID
    });

    return res.status(200).json({
      status: 'success',
      message: `Device successfully rebound for ${teacherId}`,
      data: binding
    });
  } catch (err) {
    console.error('Rebind device error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

/**
 * Admin: Reset a teacher's device binding
 * This clears the binding so the next device content can bind.
 */
exports.resetBinding = async (req, res) => {
  try {
    const { teacherId } = req.body;

    if (!teacherId) {
      return res.status(400).json({ status: 'fail', message: 'Teacher ID is required.' });
    }

    // 1. Remove from DeviceBinding collection
    const deletedBinding = await DeviceBinding.findOneAndDelete({ teacher: teacherId });

    // 2. Clear fields in Teacher model (if used)
    await Teacher.findByIdAndUpdate(teacherId, {
      $set: {
        deviceId: null,
        deviceName: '',
        deviceBoundAt: null
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Device binding reset successfully.',
      data: deletedBinding
    });
  } catch (err) {
    console.error('Reset binding error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};
