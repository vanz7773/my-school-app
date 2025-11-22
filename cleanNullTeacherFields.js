const mongoose = require('mongoose');
const Class = require('./models/Class'); // adjust path
const dbUrl = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // update accordingly

async function cleanNullTeacherFields() {
  await mongoose.connect(dbUrl);
  console.log('✅ Connected to MongoDB');

  const result = await Class.updateMany(
    { teacher: { $in: [null, undefined] } },
    { $unset: { teacher: "" } }
  );

  console.log(`🧹 Removed 'teacher' field from ${result.modifiedCount} class(es) with null/undefined values.`);
  await mongoose.disconnect();
}

cleanNullTeacherFields();
