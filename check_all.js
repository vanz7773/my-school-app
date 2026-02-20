const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const recent = await Attendance.find().sort({ createdAt: -1 }).limit(10).lean();
  console.log("Most recent 10 attendance records:");
  for (const r of recent) {
      console.log(`- school: ${r.school}, termId: ${r.termId}, class: ${r.class}, week: '${r.week}', weekNumber: ${r.weekNumber}, days: ${JSON.stringify(r.days)}`);
  }
  process.exit(0);
}
run();
