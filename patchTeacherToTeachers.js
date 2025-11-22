const mongoose = require('mongoose');
const Class = require('./models/Class'); // Adjust path if needed
const dbUrl = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // Change this to your MongoDB URI

async function patchTeacherToTeachers() {
  await mongoose.connect(dbUrl);
  console.log('✅ Connected to MongoDB');

  const classesToFix = await Class.find({
    teacher: { $exists: true },
    $or: [{ teachers: { $exists: false } }, { teachers: { $size: 0 } }]
  });

  console.log(`🔍 Found ${classesToFix.length} class(es) with teacher field and empty teachers[]`);

  for (const cls of classesToFix) {
    if (cls.teacher) {
      cls.teachers = [cls.teacher];
      cls.teacher = undefined; // or: delete cls.teacher;
      await cls.save();
      console.log(`✅ Patched class: ${cls.name} (${cls._id})`);
    }
  }

  console.log('🎉 Patch complete.');
  await mongoose.disconnect();
}

patchTeacherToTeachers().catch(err => {
  console.error('❌ Migration failed:', err);
});
