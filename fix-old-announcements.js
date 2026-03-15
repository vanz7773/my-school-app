require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('./models/Notification');
const User = require('./models/User');

async function fixOldNotifications() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB');

    // Get all admins
    const admins = await User.find({ role: 'admin' }).select('_id school').lean();
    console.log(`Found ${admins.length} admins.`);

    let updatedCount = 0;

    for (const admin of admins) {
      // Find announcements for this admin's school where admin is NOT in recipientUsers
      const notifications = await Notification.find({
        type: 'announcement',
        school: admin.school,
        recipientUsers: { $ne: admin._id }
      });

      for (const notif of notifications) {
        notif.recipientUsers.push(admin._id);
        await notif.save();
        updatedCount++;
      }
    }

    console.log(`Successfully retroactively updated ${updatedCount} notifications to include admins.`);
  } catch (err) {
    console.error('Error fixing old notifications:', err);
  } finally {
    mongoose.disconnect();
  }
}

fixOldNotifications();
