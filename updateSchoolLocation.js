const mongoose = require('mongoose');

// Replace with your actual MongoDB connection string
const MONGO_URI = 'mongodb+srv://oseievanslolo:7LLxvJh8RtTZxTxa@school1.fqda1t3.mongodb.net/?retryWrites=true&w=majority&appName=SCHOOL1'; // or your Atlas URI

// Connect to MongoDB
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('✅ Connected to MongoDB');
    return updateSchoolLocation();
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
  });

// Update location field for the school
async function updateSchoolLocation() {
  const School = mongoose.model('School', new mongoose.Schema({}, { strict: false }));

  const result = await School.updateOne(
    { _id: new mongoose.Types.ObjectId('6869874e7fe4376b23187d51') },
    {
      $set: {
        location: {
          type: 'Polygon',
          coordinates: [
            [
              [ -0.2059, 5.6145 ],
              [ -0.2060, 5.6150 ],
              [ -0.2055, 5.6152 ],
              [ -0.2052, 5.6148 ],
              [ -0.2059, 5.6145 ] // closes the polygon
            ]
          ]
        }
      }
    }
  );

  console.log(`🔄 Update result:`, result);
  mongoose.disconnect();
}
