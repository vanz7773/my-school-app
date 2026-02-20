const mongoose = require('mongoose');
const Class = require('./models/Class');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const c = await Class.findById("6863f21c66b87da2fed9c021");
  console.log(c);
  process.exit(0);
}
run();
