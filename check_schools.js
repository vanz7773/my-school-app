const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
require('dotenv').config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    const bySchool = await Attendance.aggregate([
        { $group: { _id: '$school', count: { $sum: 1 } } }
    ]);
    console.log("Attendance by school:", bySchool);
    process.exit(0);
}
run();
