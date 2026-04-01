const { processTransportJob } = require('./controllers/transportController');
const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/sms-mobile')
.then(async () => {
    // get a student 
    const student = await mongoose.model('Student').findOne();
    const term = await mongoose.model('Term').findOne();
    const schoolId = student.school;
    
    // Test process job
    try {
        const res = await processTransportJob({
            student: student._id,
            termId: term._id,
            academicYear: "2024/2025",
            week: "Week 4",
            day: "M",
            status: "boarded",
            routeSnapshot: "Test",
            stopSnapshot: "Test",
            reqUser: { school: schoolId, _id: student._id }
        });
        console.log("Success:", res);
    } catch(err) {
        console.error("Test Error:", err);
    }

    mongoose.disconnect();
})
.catch(err => console.error("Connect error:", err));
