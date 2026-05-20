const mongoose = require('mongoose');
require('dotenv').config(); // loads .env from current working directory

const Teacher = require('../models/Teacher');
const ClockInException = require('../models/ClockInException');
const User = require('../models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to Database');

    const exceptions = await ClockInException.find().lean();
    console.log(`Found ${exceptions.length} exceptions in DB.`);

    for (const exc of exceptions) {
      console.log(`Processing exception _id: ${exc._id}, teacherId field: ${exc.teacherId}`);
      
      // Check if this ID is a Teacher
      const teacher = await Teacher.findById(exc.teacherId);
      if (teacher) {
        console.log(`  -> Valid Teacher ID!`);
        continue;
      }

      // Check if this ID is a User
      const user = await User.findById(exc.teacherId);
      if (user) {
        console.log(`  -> Found User document for this ID instead! Name: ${user.name}`);
        
        // Find the actual Teacher document associated with this user
        const realTeacher = await Teacher.findOne({ user: user._id });
        if (realTeacher) {
          console.log(`  -> Found associated Teacher document! _id: ${realTeacher._id}`);
          
          // Check if there is already an exception for the actual Teacher ID
          const existingTeacherExc = await ClockInException.findOne({ teacherId: realTeacher._id });
          if (existingTeacherExc) {
            console.log(`  -> An exception already exists for this Teacher ID!`);
            // Merge: Keep the larger customRadius or the one that is active
            const finalRadius = Math.max(exc.customRadius, existingTeacherExc.customRadius);
            const finalActive = exc.isActive || existingTeacherExc.isActive;
            
            existingTeacherExc.customRadius = finalRadius;
            existingTeacherExc.isActive = finalActive;
            await existingTeacherExc.save();
            console.log(`  -> Updated existing Teacher exception to radius ${finalRadius}m`);
            
            // Delete the incorrect one
            await ClockInException.deleteOne({ _id: exc._id });
            console.log(`  -> Deleted the old/incorrect User-based exception.`);
          } else {
            // Update the teacherId field to the actual Teacher ID
            await ClockInException.updateOne(
              { _id: exc._id },
              { $set: { teacherId: realTeacher._id } }
            );
            console.log(`  -> Updated exception teacherId from User ID to Teacher ID.`);
          }
        } else {
          console.log(`  ⚠️ No Teacher document found for User ID: ${user._id}`);
        }
      } else {
        console.log(`  ⚠️ ID ${exc.teacherId} matches neither a Teacher nor a User.`);
      }
    }

    console.log('\n--- VERIFYING CURRENT EXCEPTIONS ---');
    const updatedExceptions = await ClockInException.find().lean();
    for (const exc of updatedExceptions) {
      const teacher = await Teacher.findById(exc.teacherId).populate('user').lean();
      console.log(`Exception _id: ${exc._id} | teacherId: ${exc.teacherId} | customRadius: ${exc.customRadius}m | isActive: ${exc.isActive}`);
      if (teacher) {
        console.log(`  -> Associated Teacher: ${teacher.user?.name || 'Unknown'}`);
      } else {
        console.log(`  -> ⚠️ NO Teacher document found!`);
      }
    }

  } catch (err) {
    console.error('Error during migration:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected');
  }
}

run();
