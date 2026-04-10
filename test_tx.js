const mongoose = require('mongoose');
require('dotenv').config();

async function testTx() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/school_db');
    const session = await mongoose.startSession();
    session.startTransaction();
    console.log("Transaction started successfully!");
    session.endSession();
  } catch (err) {
    console.error("Tx Error:", err.message);
  } finally {
    mongoose.connection.close();
  }
}
testTx();
