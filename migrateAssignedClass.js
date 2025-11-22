const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Teacher = require('./models/Teacher');
const Class = require('./models/Class');

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ Connection error:', err));

async function migrateAssignedClasses() {
  try {
    const teachers = await Teacher.find();
    const classes = await Class.find(); // preload all classes

    let updatedCount = 0;

    for (const teacher of teachers) {
      const assignedClass = teacher.assignedClass;

      // Skip if already ObjectId
      if (typeof assignedClass === 'string' && assignedClass.length === 24) {
        continue;
      }

      if (typeof assignedClass === 'string') {
        const match = classes.find(cls =>
          cls.name.toLowerCase() === assignedClass.toLowerCase()
        );

        if (match) {
          await Teacher.updateOne(
            { _id: teacher._id },
            { assignedClass: match._id }
          );
          console.log(`✅ Updated ${teacher.user || teacher._id}: ${match.name}`);
          updatedCount++;
        } else {
          console.log(`❌ No class found for name: "${assignedClass}"`);
        }
      }
    }

    console.log(`\n🎉 Migration complete. Total updated: ${updatedCount}`);
  } catch (err) {
    console.error('❌ Migration failed:', err);
  } finally {
    mongoose.disconnect();
  }
}

migrateAssignedClasses();
