const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const att = await Attendance.find().limit(5);
  console.log(att.map(a => ({ id: a._id, week: a.week, weekNumber: a.weekNumber })));
  process.exit(0);
}
run();
