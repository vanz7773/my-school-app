const mongoose = require('mongoose');
const dashboardController = require('./controllers/dashboardController');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const req = {
    user: { school: "6869874e7fe4376b23187d51" }, // from my previous script
    query: {}
  };
  
  const res = {
    json: function(data) { console.log("Success with data:", JSON.stringify(data, null, 2)); },
    status: function(code) { 
        return { 
            json: function(data) { console.error("Error", code, ":", data); }
        };
    }
  };

  console.log("Testing weekly-attendance...");
  await dashboardController.getWeeklyAttendance(req, res);
  
  process.exit(0);
}
run();
