const mongoose = require('mongoose');
const Term = require('./models/Term');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const terms = await Term.find({ isActive: true }).select('school term academicYear isActive');
  console.log("Terms with isActive: true =>", terms.length);
  for (const t of terms) {
      console.log(`- School: ${t.school}, Term: ${t.term}, Year: ${t.academicYear}`);
  }
  process.exit(0);
}
run();
