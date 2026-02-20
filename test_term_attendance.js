const mongoose = require('mongoose');
const dashboardController = require('./controllers/dashboardController');
const Term = require('./models/Term');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const term = await Term.findOne({ isActive: true });
  
  // Create mock req and res
  const req = {
    user: { school: "6869874e7fe4376b23187d51" },
    query: { termId: term ? term._id.toString() : undefined }
  };
  
  const res = {
    json: function(data) { console.log(JSON.stringify(data, null, 2)); },
    status: function(code) { return { json: function(data) { console.error(data); } } }
  };

  await dashboardController.getWeeklyAttendance(req, res);
  process.exit(0);
}
run();
