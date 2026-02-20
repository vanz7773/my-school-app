const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  // Get any valid school and term
  const att = await Attendance.findOne();
  if(!att) { console.log("No attendance"); process.exit(0); }
  
  console.log("Found attendance for school:", att.school, "term:", att.termId, "week:", att.week);
  
  const result = await Attendance.aggregate([
    {
      $match: {
        school: att.school,
        termId: att.termId,
        week: { $exists: true }
      }
    },
    {
      $group: {
        _id: '$week',
        count: { $sum: 1 }
      }
    }
  ]);
  
  console.log("Weekly attendance aggregation:", result);
  process.exit(0);
}
run();
