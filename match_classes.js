const mongoose = require('mongoose');
const dashboardController = require('./controllers/dashboardController');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Use a known school "6869874e7fe4376b23187d51"
  const req = {
    user: { school: "6869874e7fe4376b23187d51" },
    query: {}
  };
  
  let studentsRes, attRes;
  
  const resStudents = {
    json: function(data) { studentsRes = data; },
    status: () => ({ json: console.error })
  };
  
  const resAtt = {
    json: function(data) { attRes = data; },
    status: () => ({ json: console.error })
  };

  await dashboardController.getStudentsByClass(req, resStudents);
  await dashboardController.getWeeklyAttendance(req, resAtt);
  
  const studentClasses = studentsRes.map(c => c.className);
  
  const attClasses = new Set();
  attRes.forEach(week => {
      week.classes.forEach(c => attClasses.add(c.className));
  });
  
  console.log("Students By Class dropdpwn items:", studentClasses);
  console.log("Weekly Attendance items:", Array.from(attClasses));
  
  process.exit(0);
}
run();
