const mongoose = require('mongoose');
const SchoolTransaction = require('../models/SchoolTransaction');

// Atomically reserve the one-time confirmation for this admin across tabs/devices.
exports.acknowledgePaymentConfirmation = async (req, res) => {
  if (req.user?.role !== 'admin' || !req.user.school || !req.user._id) {
    return res.status(403).json({ message: 'Only school admins can acknowledge subscription payments.' });
  }
  if (!mongoose.isValidObjectId(req.params.paymentId)) {
    return res.status(400).json({ message: 'Invalid payment ID.' });
  }
  try {
    const payment = await SchoolTransaction.findOneAndUpdate({
      _id: req.params.paymentId, school: req.user.school, status: 'paid',
      confirmationSeenBy: { $ne: req.user._id }
    }, { $addToSet: { confirmationSeenBy: req.user._id } }, {
      new: true, timestamps: false
    });
    // A missing, other-school or already acknowledged payment must never open a dialog.
    return res.json({ success: true, shouldShow: Boolean(payment) });
  } catch (error) {
    console.error('Subscription payment acknowledgement failed:', error.message);
    return res.status(500).json({ message: 'Unable to acknowledge payment confirmation.' });
  }
};
