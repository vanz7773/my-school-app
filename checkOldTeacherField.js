const mongoose = require('mongoose');
const Class = require('./models/Class');
require('dotenv').config();

async function findOldTeacherField() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  const withTeacher = await Class.find({ teacher: { $exists: true } });

  if (withTeacher.length === 0) {
    console.log('✅ No classes found with legacy `teacher` field — migration likely complete.');
  } else {
    console.log(`⚠️ ${withTeacher.length} class(es) still have the old \`teacher\` field:`);
    withTeacher.forEach(cls => {
      console.log(`- ${cls.name} (${cls._id}) | teacher: ${cls.teacher}`);
    });
  }

  process.exit(0);
}

findOldTeacherField();
