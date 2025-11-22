const mongoose = require('mongoose');
const Class = require('./models/Class'); // adjust path
const dbUrl = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // update accordingly

async function logProblematicClasses() {
  await mongoose.connect(dbUrl);
  console.log('✅ Connected to MongoDB');

  const classes = await Class.find({
    teacher: { $exists: true },
    $or: [{ teachers: { $exists: false } }, { teachers: { $size: 0 } }]
  });

  if (classes.length === 0) {
    console.log('🎉 No remaining classes with old `teacher` field.');
  } else {
    console.log(`⚠️ Still ${classes.length} class(es) with potential teacher field issue:`);
    classes.forEach(cls => {
      console.log(`- ${cls.name} (${cls._id}) | teacher:`, cls.teacher);
    });
  }

  await mongoose.disconnect();
}

logProblematicClasses();
