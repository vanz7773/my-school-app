const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const TransportRoute = require('./models/TransportRoute');
const TransportEnrollment = require('./models/TransportEnrollment');
const TransportAssignment = require('./models/TransportAssignment');
const Student = require('./models/Student');
const User = require('./models/User');

async function diagnose() {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/school-app';
    console.log('Connecting to:', mongoURI);
    await mongoose.connect(mongoURI);
    console.log('Connected to MongoDB');

    const today = new Date().toISOString().split('T')[0];
    console.log('Checking for assignments on:', today);

    const assignments = await TransportAssignment.find({ date: today }).populate('teacher', 'name').populate('route', 'name');
    console.log(`Found ${assignments.length} assignments for today`);
    
    for (const ass of assignments) {
      const Teacher = require('./models/Teacher');
      const teacherProfile = await Teacher.findById(ass.teacher?._id || ass.teacher).populate('user', 'name');
      const teacherUser = await User.findById(ass.teacher?._id || ass.teacher);
      
      console.log(`- Assignment: Route ${ass.route?.name} (${ass.route?._id}), Teacher Field ID: ${ass.teacher?._id || ass.teacher}, Term: ${ass.term}, School: ${ass.school}`);
      if (teacherProfile) {
        console.log(`  - ID matches a Teacher Profile. Linked User: ${teacherProfile.user?.name} (${teacherProfile.user?._id}), Profile School: ${teacherProfile.school}`);
      } else if (teacherUser) {
        console.log(`  - ID matches a User record directly. Name: ${teacherUser.name}, User School: ${teacherUser.school}`);
      } else {
        console.log(`  - ID does NOT match any known User or Teacher Profile.`);
      }
      
      const enrollments = await TransportEnrollment.find({
        route: ass.route?._id,
        term: ass.term,
        status: 'active'
      }).populate('student', 'name school');
      console.log(`  - Enrollments found for this route/term: ${enrollments.length}`);
      
      for (const enr of enrollments) {
         console.log(`    * Student: ${enr.student?.name || 'Unknown'}, Enrollment School: ${enr.school}, Student School: ${enr.student?.school}`);
      }
    }

    // Global stats
    const totalEnrollments = await TransportEnrollment.countDocuments({ status: 'active' });
    console.log('Total active enrollments across all terms/routes:', totalEnrollments);

    const recentEnrollments = await TransportEnrollment.find().sort({ createdAt: -1 }).limit(5).populate('route', 'name').populate('student', 'name');
    console.log('Most recent 5 enrollments:');
    recentEnrollments.forEach(e => {
       console.log(`- Student: ${e.student?.name || 'Unknown'}, Route: ${e.route?.name || 'Unknown'}, Term: ${e.term}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Diagnosis failed:', err);
    process.exit(1);
  }
}

diagnose();
