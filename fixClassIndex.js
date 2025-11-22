const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // 🔁 Replace with your actual MongoDB URI

async function dropOldClassIndex() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const indexes = await db.collection('classes').indexes();

    console.log('Current indexes on classes collection:');
    console.table(indexes.map(({ name, key }) => ({ name, key: JSON.stringify(key) })));

    const nameOnlyIndex = indexes.find(index => index.name === 'name_1');

    if (nameOnlyIndex) {
      console.log('Found old name_1 index. Dropping...');
      await db.collection('classes').dropIndex('name_1');
      console.log('✅ Dropped old name_1 index');
    } else {
      console.log('✅ No old name_1 index found — nothing to drop');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error handling indexes:', error);
    process.exit(1);
  }
}

dropOldClassIndex();
