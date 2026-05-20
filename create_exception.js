const mongoose = require('mongoose');
require('dotenv').config();

const ClockInException = require('./models/ClockInException');

async function seedException() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
    console.log('📦 Connected to Database');

    const inputId = '69b80d7f6277a43c65f24424';
    const customRadius = 50000; // Use the 50000m radius as requested/intended

    // Resolve teacher ID: Could be a Teacher ID or a User ID
    const Teacher = require('./models/Teacher');
    const User = require('./models/User');

    let teacher = await Teacher.findById(inputId);
    let resolvedTeacherId = null;

    if (teacher) {
      resolvedTeacherId = teacher._id;
      console.log(`Found teacher by Teacher ID: ${resolvedTeacherId}`);
    } else {
      // Check if it's a User ID
      const user = await User.findById(inputId);
      if (user) {
        teacher = await Teacher.findOne({ user: user._id });
        if (teacher) {
          resolvedTeacherId = teacher._id;
          console.log(`Resolved User ID ${inputId} to Teacher ID: ${resolvedTeacherId} (Name: ${user.name})`);
        } else {
          throw new Error(`User found for ID ${inputId}, but no Teacher profile is linked to this user.`);
        }
      } else {
        throw new Error(`No Teacher or User document found with ID: ${inputId}`);
      }
    }

    // Check if exception already exists
    let exception = await ClockInException.findOne({ teacherId: resolvedTeacherId });
    if (exception) {
      exception.customRadius = customRadius;
      exception.isActive = true;
      await exception.save();
      console.log(`✅ Updated existing exception for teacher ${resolvedTeacherId} to radius ${customRadius}m`);
    } else {
      exception = new ClockInException({
        teacherId: resolvedTeacherId,
        customRadius,
        isActive: true
      });
      await exception.save();
      console.log(`✅ Created new exception for teacher ${resolvedTeacherId} with radius ${customRadius}m`);
    }

  } catch (error) {
    console.error('❌ Error creating exception:', error);
  } finally {
    mongoose.disconnect();
    console.log('👋 Disconnected');
  }
}

seedException();
