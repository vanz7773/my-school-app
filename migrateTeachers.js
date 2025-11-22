// migrateTeachers.js

const mongoose = require('mongoose');
const Class = require('./models/Class'); // Adjust path if needed
require('dotenv').config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const classes = await Class.find({ teacher: { $ne: null } });

    let migratedCount = 0;

    for (const cls of classes) {
      if (
        cls.teacher &&
        (!cls.teachers || !Array.isArray(cls.teachers) || cls.teachers.length === 0 || cls.teachers[0] === null)
      ) {
        cls.teachers = [cls.teacher];
        cls.teacher = undefined; // remove legacy field
        await cls.save();
        migratedCount++;
      } else if (cls.teacher && !cls.teachers.includes(cls.teacher)) {
        // Avoid duplicates
        cls.teachers.push(cls.teacher);
        cls.teacher = undefined;
        await cls.save();
        migratedCount++;
      }
    }

    // Optional: Clean up teachers: [null]
    const cleaned = await Class.updateMany(
      { teachers: [null] },
      { $set: { teachers: [] } }
    );

    console.log(`✅ Migration complete: ${migratedCount} classes updated.`);
    console.log(`🧹 Cleaned ${cleaned.modifiedCount} classes with [null] in teachers array.`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
