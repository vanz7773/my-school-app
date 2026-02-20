const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const term2Id = "68957e7c0162f2229343a689"; // Extracted from debug_attendance.js
  
  const count = await Attendance.countDocuments({ termId: term2Id });
  console.log("Total attendance for Term2 (across all schools):", count);
  
  process.exit(0);
}
run();
