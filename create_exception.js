const mongoose = require('mongoose');
require('dotenv').config();

const ClockInException = require('./models/ClockInException');

async function seedException() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
    console.log('📦 Connected to Database');

    const teacherId = '69b80d7f6277a43c65f24424';
    const customRadius = 400;

    // Check if exception already exists
    let exception = await ClockInException.findOne({ teacherId });
    if (exception) {
      exception.customRadius = customRadius;
      exception.isActive = true;
      await exception.save();
      console.log(`✅ Updated existing exception for teacher ${teacherId} to radius ${customRadius}m`);
    } else {
      exception = new ClockInException({
        teacherId,
        customRadius,
        isActive: true
      });
      await exception.save();
      console.log(`✅ Created new exception for teacher ${teacherId} with radius ${customRadius}m`);
    }

  } catch (error) {
    console.error('❌ Error creating exception:', error);
  } finally {
    mongoose.disconnect();
    console.log('👋 Disconnected');
  }
}

seedException();
