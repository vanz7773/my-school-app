const mongoose = require('mongoose');
const Student = require('./models/Student');
require('dotenv').config();

const updatePhoneNumbers = async () => {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/school_management';
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB.');

    // Find all students with exactly 9 characters in guardianPhone
    const studentsToFix = await Student.find({
        guardianPhone: { $regex: /^[1-9]\d{8}$/ }
    });

    console.log(`Found ${studentsToFix.length} students with 9-digit phone numbers.`);

    let updatedCount = 0;
    for (const student of studentsToFix) {
      const oldPhone = student.guardianPhone;
      student.guardianPhone = '0' + student.guardianPhone;
      await student.save();
      console.log(`Updated ${student?.user?.name || student._id} - Old: ${oldPhone} | New: ${student.guardianPhone}`);
      updatedCount++;
    }

    console.log(`Successfully updated ${updatedCount} phone numbers.`);
    process.exit(0);
  } catch (error) {
    console.error('Error updating phone numbers:', error);
    process.exit(1);
  }
};

updatePhoneNumbers();
