// normalizeClassNames.js
const mongoose = require('mongoose');
const Class = require('./models/Class');
const School = require('./models/School');

const MONGO_URI = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // 🔁 Update to your MongoDB URI

// Predefined class order
const CLASS_ORDER = [
  'NURSERY 1', 
  'NURSERY 2', 
  'KG 1', 
  'KG 2',
  'BASIC 1', 
  'BASIC 2', 
  'BASIC 3', 
  'BASIC 4', 
  'BASIC 5',
  'BASIC 6', 
  'BASIC 7', 
  'BASIC 8', 
  'BASIC 9'
];
async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // ✅ Get the default school (if only one exists, or use specific _id)
    const school = await School.findOne(); // Or use findById('your-school-id')

    if (!school) {
      throw new Error('❌ No school found in database. Aborting.');
    }

    const allClasses = await Class.find();

    // Normalize names to uppercase and assign school if missing
    for (const c of allClasses) {
      const updatedName = c.name.toUpperCase().trim();
      let modified = false;

      if (c.name !== updatedName) {
        c.name = updatedName;
        modified = true;
      }

      if (!c.school) {
        c.school = school._id;
        modified = true;
      }

      if (modified) {
        await c.save();
        console.log(`🔁 Updated: ${updatedName}`);
      }
    }

    // Optional: reorder classes based on CLASS_ORDER
    const existingNames = await Class.find().distinct('name');
    const missingClasses = CLASS_ORDER.filter(name => !existingNames.includes(name));

    for (const name of missingClasses) {
      await Class.create({ name, school: school._id });
      console.log(`➕ Added missing class: ${name}`);
    }

    console.log('✅ Class normalization completed!');
    process.exit();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
