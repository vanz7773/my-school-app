// patchMixedTeacherField.js

const mongoose = require('mongoose');
const Class = require('./models/Class'); // Adjust if path differs

const dbUrl = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // ← Update this

async function run() {
  await mongoose.connect(dbUrl);
  console.log('✅ Connected to MongoDB');

  const classes = await Class.find({
    teacher: { $exists: true },
    teachers: { $exists: true }
  });

  let updated = 0;

  for (const cls of classes) {
    const teacherId = cls.teacher?.toString();
    const teacherList = cls.teachers.map(t => t.toString());

    if (teacherId && !teacherList.includes(teacherId)) {
      cls.teachers.push(cls.teacher); // Add missing teacher
      console.log(`➕ Added '${teacherId}' to class '${cls.name}'`);
    }

    // Remove the old `teacher` field
    cls.teacher = undefined;

    await cls.save();
    updated++;
  }

  console.log(`🎉 Migration done: ${updated} class(es) patched.`);
  await mongoose.disconnect();
}

run().catch(console.error);
