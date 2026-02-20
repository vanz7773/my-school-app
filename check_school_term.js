const mongoose = require('mongoose');
const Attendance = require('./models/StudentAttendance');
const Term = require('./models/Term');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const term = await Term.findOne({ isActive: true });
  const att = await Attendance.findOne();
  
  if (term && att) {
      console.log('Term ID:', term._id);
      console.log('Attendance Term ID:', att.termId);
      console.log('Match?', term._id.toString() === att.termId.toString());
  } else {
      console.log('term:', !!term, 'att:', !!att);
      if(!term) console.log("NO ACTIVE TERM found!");
  }
  process.exit(0);
}
run();
