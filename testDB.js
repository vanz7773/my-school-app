require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log("Connected to MongoDB");
  try {
    await mongoose.connection.collection('terms').dropIndex('school_1_year_1_term_1');
    console.log("Dropped legacy index 'school_1_year_1_term_1'");
  } catch (err) {
    console.error("Error dropping index:", err.message);
  }
  process.exit(0);
}
run();
