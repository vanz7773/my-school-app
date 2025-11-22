const mongoose = require('mongoose');
const School = require('./models/School'); // adjust path if needed

mongoose.connect('mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1') // replace with your DB
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    const schools = await School.find({});
    console.log(`🏫 Total Schools: ${schools.length}`);
    schools.forEach(s => console.log(`- ${s.name}`));
    process.exit();
  })
  .catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
