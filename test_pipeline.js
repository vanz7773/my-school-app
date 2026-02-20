const mongoose = require('mongoose');
const dashboardController = require('./controllers/dashboardController');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const req = { user: { school: "6869874e7fe4376b23187d51" }, query: {} };
  
  // Custom pipeline test
  const Attendance = require('./models/StudentAttendance');
  const result = await Attendance.aggregate([
      { $match: { school: new mongoose.Types.ObjectId(req.user.school), week: { $exists: true } } },
      {
        $group: {
          _id: { week: '$week', class: '$class' },
          totalRecords: { $sum: 1 },
          presentM: { $sum: { $cond: [{ $eq: ['$days.M', 'present'] }, 1, 0] } },
          absentM: { $sum: { $cond: [{ $eq: ['$days.M', 'absent'] }, 1, 0] } },
          markedM: { $sum: { $cond: [{ $ne: ['$days.M', 'notmarked'] }, 1, 0] } },
        }
      },
      {
         $project: {
             markedM: 1,
             presentM: 1,
             absentM: 1
         }
      }
  ]);
  
  console.log(JSON.stringify(result.slice(0, 3), null, 2));
  process.exit(0);
}
run();
