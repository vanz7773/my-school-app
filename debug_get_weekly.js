const mongoose = require('mongoose');
const dashboardController = require('./controllers/dashboardController');
const Term = require('./models/Term');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Look for any attendance recently created
  const recent = await Attendance.findOne().sort({ createdAt: -1 }).lean();
  if(!recent) {
    console.log("No attendance ever taken.");
    process.exit(0);
  }
  console.log("Most recent attendance record:", recent);
  
  // Run getWeeklyAttendance for that school and term
  const req = {
    user: { school: recent.school.toString() },
    query: { termId: recent.termId.toString() }
  };
  
  const res = {
    json: function(data) { console.log("\ngetWeeklyAttendance output:", JSON.stringify(data, null, 2)); },
    status: function(code) { return { json: function(data) { console.error("Error", code, ":", data); } } }
  };

  await dashboardController.getWeeklyAttendance(req, res);
  process.exit(0);
}
run();
