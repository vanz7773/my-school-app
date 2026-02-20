const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const result = await Attendance.aggregate([
    {
      $group: {
        _id: '$week',
        count: { $sum: 1 }
      }
    }
  ]);
  
  console.log("All distinct weeks in DB:", result);
  process.exit(0);
}
run();
