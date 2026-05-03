const mongoose = require('mongoose');
const Notification = require('../models/Notification');
require('dotenv').config();

async function cleanup() {
  try {
    console.log('🚀 Starting notification cleanup...');
    
    // Connect to DB (assuming URI is in env)
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/school_portal';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');

    // 1. Fix "Welcome" notifications that should be specific
    const welcomeResult = await Notification.updateMany(
      { 
        title: /Welcome|New student|New teacher|New Parent/i,
        audience: 'all' 
      },
      { $set: { audience: 'specific' } }
    );
    console.log(`📝 Updated ${welcomeResult.modifiedCount} "Welcome" notifications to 'specific' audience.`);

    // 2. Fix Password Reset notifications
    const resetResult = await Notification.updateMany(
      { 
        type: { $in: ['reset-approved', 'reset-rejected'] },
        audience: { $ne: 'specific' } 
      },
      { $set: { audience: 'specific' } }
    );
    console.log(`📝 Updated ${resetResult.modifiedCount} password reset notifications to 'specific' audience.`);

    console.log('✨ Cleanup complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  }
}

cleanup();
