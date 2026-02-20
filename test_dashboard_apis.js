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
    json: function(data) { console.log("Success with data length:", data.length); },
    status: function(code) { 
        return { 
            json: function(data) { console.error("Error", code, ":", data); }
        };
    }
  };

  console.log("Testing students-by-class...");
  await dashboardController.getStudentsByClass(req, res);
  
  console.log("Testing average-grades...");
  await dashboardController.getAverageGrades(req, res);
  
  process.exit(0);
}
run();
