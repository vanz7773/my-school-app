const mongoose = require('mongoose');
require('dotenv').config();
const StudentAttendance = require('./models/StudentAttendance');

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const docs = await StudentAttendance.find({ "days.M": "absent" }).limit(3);
  console.log(JSON.stringify(docs.map(d => d.days), null, 2));
  process.exit(0);
}
test();
