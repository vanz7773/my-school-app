// fixAcademicYears.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Student = require('./models/Student'); // adjust the path if needed

dotenv.config(); // Load .env

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // fallback if not set
const DEFAULT_YEAR = '2024-2025'; // Set your intended default year

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const result = await Student.updateMany(
      { academicYear: { $exists: false } },
      { $set: { academicYear: DEFAULT_YEAR } }
    );

    console.log(`🎯 Updated ${result.modifiedCount} students with academic year "${DEFAULT_YEAR}"`);
  } catch (err) {
    console.error('❌ Error updating students:', err);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
})();
