const mongoose = require('mongoose');
require('dotenv').config(); // loads .env from current working directory

const Teacher = require('../models/Teacher');
const ClockInException = require('../models/ClockInException');
const User = require('../models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('CONNECTED TO DB');

    console.log('\n--- ALL CLOCK IN EXCEPTIONS ---');
    const exceptions = await ClockInException.find().lean();
    console.log(JSON.stringify(exceptions, null, 2));

    console.log('\n--- RELEVANT TEACHERS ---');
    for (const exc of exceptions) {
      const teacher = await Teacher.findById(exc.teacherId).populate('user').lean();
      console.log(`Exception teacherId: ${exc.teacherId}`);
      if (teacher) {
        console.log(`  Found Teacher Document! _id: ${teacher._id}`);
        console.log(`  Associated User Name: ${teacher.user?.name}, role: ${teacher.user?.role}, email: ${teacher.user?.email}`);
      } else {
        console.log('  ⚠️ NO Teacher document found for this teacherId!');
        // Check if it exists as a User ID instead
        const user = await User.findById(exc.teacherId).lean();
        if (user) {
          console.log(`  Found User Document with this ID! Name: ${user.name}, role: ${user.role}, email: ${user.email}`);
          // Find if there is a Teacher document pointing to this User
          const realTeacher = await Teacher.findOne({ user: user._id }).lean();
          if (realTeacher) {
            console.log(`    -> Real Teacher document found! _id: ${realTeacher._id}`);
          } else {
            console.log(`    -> ⚠️ No Teacher document references this user.`);
          }
        } else {
          console.log('  ⚠️ No User document found with this ID either!');
        }
      }
    }

    console.log('\n--- ALL TEACHERS ---');
    const allTeachers = await Teacher.find().populate('user').limit(10).lean();
    allTeachers.forEach(t => {
      console.log(`Teacher _id: ${t._id} | User _id: ${t.user?._id} | Name: ${t.user?.name} | Email: ${t.user?.email}`);
    });

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    console.log('DISCONNECTED');
  }
}

run();
