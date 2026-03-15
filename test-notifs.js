require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('./models/Notification');
const User = require('./models/User');

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const admin = await User.findOne({ role: 'admin' }).lean();
  console.log('Admin ID:', admin._id);

  const notifs = await Notification.find({ type: 'announcement' }).sort({ createdAt: -1 }).limit(3).lean();
  console.log('Recent Notifications:', JSON.stringify(notifs, null, 2));
  mongoose.disconnect();
}
test();
