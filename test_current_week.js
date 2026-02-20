const mongoose = require('mongoose');
const Term = require('./models/Term');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const term = await Term.findOne({ isActive: true });
  console.log(JSON.stringify(term, null, 2));
  process.exit(0);
}
run();
