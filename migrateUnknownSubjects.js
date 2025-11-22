const mongoose = require('mongoose');
const Teacher = require('./models/Teacher');
const Subject = require('./models/Subject');

async function migrateUnknownSubjects() {
  await mongoose.connect(
    'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1',
    { useNewUrlParser: true, useUnifiedTopology: true }
  );

  // Find teachers whose subject is still a string (legacy format)
  const oldTeachers = await Teacher.find({ subject: { $type: 'string' } }).populate('school');
  console.log(`Found ${oldTeachers.length} teachers with old string subjects`);

  for (const teacher of oldTeachers) {
    if (!teacher.subject || !teacher.school) {
      console.log(`Skipping teacher ${teacher._id} because subject is empty or school is missing`);
      continue;
    }

    const schoolId = teacher.school._id;
    const oldSubjectString = teacher.subject.trim().toUpperCase();

    // Try to find an existing Subject with this name in the same school
    let subjectDoc = await Subject.findOne({
      school: schoolId,
      $or: [
        { name: oldSubjectString },
        { shortName: oldSubjectString },
        { aliases: oldSubjectString }
      ]
    });

    // If not found, create a new Subject
    if (!subjectDoc) {
      subjectDoc = await Subject.create({
        school: schoolId,
        name: oldSubjectString,
        shortName: oldSubjectString,
        aliases: [],
      });
      console.log(`Created new subject "${oldSubjectString}" for school ${schoolId}`);
    }

    // Update teacher's subject field to the ObjectId of the Subject
    teacher.subject = subjectDoc._id;
    await teacher.save();
    console.log(`Updated teacher ${teacher._id} subject to "${subjectDoc.name}"`);
  }

  console.log('Migration complete! All old string subjects are now proper Subject ObjectIds.');
  mongoose.disconnect();
}

migrateUnknownSubjects().catch(err => {
  console.error('Migration error:', err);
  mongoose.disconnect();
});
