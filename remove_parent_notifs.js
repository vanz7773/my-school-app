const mongoose = require('mongoose');
require('dotenv').config();

const Notification = require('./models/Notification');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  const result = await Notification.deleteMany({ 
    $or: [
      { title: 'Welcome to the School Portal', type: 'announcement' },
      { title: 'New Parent Created', type: 'announcement' }
    ]
  });

  console.log(`Successfully deleted ${result.deletedCount} old parent notifications.`);
  process.exit(0);
}
run();
