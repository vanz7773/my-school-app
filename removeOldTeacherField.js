const mongoose = require('mongoose');
const Class = require('./models/Class');
require('dotenv').config();

async function removeOldTeacherField() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const result = await Class.updateMany(
    { teacher: { $exists: true } },
    { $unset: { teacher: "" } }
  );

  console.log(`🧹 Removed 'teacher' field from ${result.modifiedCount} class(es).`);
  process.exit(0);
}

removeOldTeacherField();
