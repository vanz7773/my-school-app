// countClasses.js

const mongoose = require('mongoose');
require('dotenv').config();

const Class = require('./models/Class'); // Adjust path if needed

// Connect using .env MONGO_URI or fallback to localhost
const uri = process.env.MONGO_URI || 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1';

mongoose.connect(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log('✅ MongoDB connected');

  const count = await Class.countDocuments();
  console.log(`📚 Total classes: ${count}`);

  const classes = await Class.find({}, 'name'); // Just fetch _id and name
  classes.forEach(cls => {
    console.log(`- ${cls._id}: ${cls.name}`);
  });

  mongoose.disconnect();
})
.catch((err) => {
  console.error('❌ Error:', err);
});
