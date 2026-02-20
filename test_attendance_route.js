const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const adminId = '65d1d60920a6e0261abc1234'; // Replace with any valid ObjectId if needed, not strictly necessary if we mock req.user
  const termId = null;

  const schoolId = new mongoose.Types.ObjectId("65b0f4d3600f60c4a4a19e59"); // We need the actual school id. I'll just query one attendance record to get a school ID.
  const att = await Attendance.findOne();
  if(!att) return console.log('No attendance');
  
  const result = await Attendance.aggregate([
      {
        $match: {
          school: att.school,
          week: { $exists: true },
        }
      },
      {
        $group: {
          _id: { week: '$week', class: '$class' },
          totalRecords: { $sum: 1 },
          presentDays: {
            $push: {
              M: { $cond: [{ $eq: ['$days.M', 'present'] }, 1, 0] },
              T: { $cond: [{ $eq: ['$days.T', 'present'] }, 1, 0] },
              W: { $cond: [{ $eq: ['$days.W', 'present'] }, 1, 0] },
              TH: { $cond: [{ $eq: ['$days.TH', 'present'] }, 1, 0] },
              F: { $cond: [{ $eq: ['$days.F', 'present'] }, 1, 0] }
            }
          }
        }
      },
      {
        $project: {
          week: '$_id.week',
          classId: '$_id.class',
          dailyPercentages: {
            M: { $multiply: [ { $divide: [{ $sum: '$presentDays.M' }, '$totalRecords'] }, 100 ] },
            T: { $multiply: [ { $divide: [{ $sum: '$presentDays.T' }, '$totalRecords'] }, 100 ] },
            W: { $multiply: [ { $divide: [{ $sum: '$presentDays.W' }, '$totalRecords'] }, 100 ] },
            TH: { $multiply: [ { $divide: [{ $sum: '$presentDays.TH' }, '$totalRecords'] }, 100 ] },
            F: { $multiply: [ { $divide: [{ $sum: '$presentDays.F' }, '$totalRecords'] }, 100 ] }
          }
        }
      },
      {
        $lookup: {
          from: 'classes',
          localField: 'classId',
          foreignField: '_id',
          as: 'classInfo'
        }
      },
      { $unwind: '$classInfo' },
      {
        $group: {
          _id: '$week',
          classes: {
            $push: {
              className: '$classInfo.name',
              days: {
                M: { $round: '$dailyPercentages.M' },
                T: { $round: '$dailyPercentages.T' },
                W: { $round: '$dailyPercentages.W' },
                TH: { $round: '$dailyPercentages.TH' },
                F: { $round: '$dailyPercentages.F' }
              }
            }
          }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          week: '$_id',
          classes: 1,
          _id: 0
        }
      }
    ]);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}
run();
