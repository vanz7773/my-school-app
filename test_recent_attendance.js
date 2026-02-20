const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
const Term = require('./models/Term');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const currentTerm = await Term.findOne({ isActive: true });
  console.log("Current Term:", currentTerm ? currentTerm.term : 'N/A', currentTerm ? currentTerm._id : 'N/A');
  
  const recent = await Attendance.find().sort({ createdAt: -1 }).limit(10).lean();
  console.log("Most recent 10 attendance records:");
  for (const r of recent) {
      console.log(`- termId: ${r.termId}, class: ${r.class}, week: '${r.week}', weekNumber: ${r.weekNumber}, days: ${JSON.stringify(r.days)}`);
  }

  process.exit(0);
}
run();
