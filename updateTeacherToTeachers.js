// migration/updateTeacherToTeachers.js
const mongoose = require('mongoose');
const Class = require('./models/class'); // Adjust path if needed

// Connect to MongoDB
mongoose.connect('mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('✅ Connected to DB');

    const classesToUpdate = await Class.find({
      teacher: { $ne: null }, // legacy field exists and is not null
    });

    console.log(`Found ${classesToUpdate.length} classes to migrate...`);

    for (const cls of classesToUpdate) {
      if (!cls.teachers || cls.teachers.length === 0) {
        cls.teachers = [cls.teacher]; // Move to new array
      } else if (!cls.teachers.includes(cls.teacher)) {
        cls.teachers.push(cls.teacher); // Merge if not already added
      }

      cls.teacher = undefined; // Remove legacy field
      await cls.save();
      console.log(`✅ Migrated class: ${cls.name}`);
    }

    console.log('🎉 Migration complete!');
    process.exit();
  })
  .catch((err) => {
    console.error('❌ Error during migration:', err);
    process.exit(1);
  });
