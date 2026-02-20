const mongoose = require('mongoose');
const Term = require('./models/Term');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const schoolIdStr = "6869874e7fe4376b23187d51";
  const schoolId = new mongoose.Types.ObjectId(schoolIdStr);
  
  const today = new Date();
  const currentTerm = await Term.findOne({
    school: schoolId,
    startDate: { $lte: today },
    endDate: { $gte: today }
  }).lean();
  
  console.log("Current Term:", currentTerm ? currentTerm.term : 'No active term');
  console.log("Current Term ID:", currentTerm ? currentTerm._id : 'N/A');

  if (currentTerm) {
      const termId = currentTerm._id;
      const count = await Attendance.countDocuments({ school: schoolId, termId: termId });
      console.log(`Attendance count for current term (${termId}):`, count);
      
      const distinctWeeks = await Attendance.distinct('week', { school: schoolId, termId: termId });
      console.log(`Distinct weeks for current term:`, distinctWeeks);
  } else {
      const count = await Attendance.countDocuments({ school: schoolId });
      console.log(`Total attendance count for school:`, count);
      
      const distinctWeeks = await Attendance.distinct('week', { school: schoolId });
      console.log(`Distinct weeks total:`, distinctWeeks);
  }

  process.exit(0);
}
run();
