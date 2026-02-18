require('dotenv').config();
const mongoose = require('mongoose');
const Student = require('./models/Student');
const Class = require('./models/Class');
const School = require('./models/School');

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        // Find a school (any school, or the one the user is likely using)
        const school = await School.findOne({ schoolType: 'Government' }); // Assuming Govt school based on context
        if (!school) {
            console.log('No Government school found, trying any school');
        }
        const targetSchool = school || await School.findOne();

        if (!targetSchool) {
            console.log('No schools found');
            process.exit(0);
        }

        console.log(`Checking data for school: ${targetSchool.name} (${targetSchool._id})`);

        // Check student count
        const studentCount = await Student.countDocuments({ school: targetSchool._id });
        console.log(`Total students in school: ${studentCount}`);

        // Check students with class
        const studentsWithClass = await Student.countDocuments({ school: targetSchool._id, class: { $ne: null } });
        console.log(`Students with class assigned: ${studentsWithClass}`);

        // Check classes
        const classes = await Class.find({ school: targetSchool._id });
        console.log(`Total classes in school: ${classes.length}`);

        if (classes.length > 0) {
            console.log('Sample Class IDs:', classes.slice(0, 3).map(c => c._id));
        }

        // Run the aggregation pipeline
        console.log('Running aggregation...');
        const result = await Student.aggregate([
            { $match: { school: targetSchool._id } },
            {
                $lookup: {
                    from: 'classes',
                    localField: 'class',
                    foreignField: '_id',
                    as: 'classInfo'
                }
            },
            { $unwind: '$classInfo' },
            {
                $group: {
                    _id: '$classInfo._id',
                    // Logic from controller
                    className: {
                        $first: {
                            $ifNull: [
                                "$classInfo.displayName",
                                { $concat: ["$classInfo.name", { $cond: [{ $ifNull: ["$classInfo.stream", false] }, { $concat: [" ", "$classInfo.stream"] }, ""] }] }
                            ]
                        }
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $project: {
                    className: 1,
                    count: 1,
                    _id: 0
                }
            }
        ]);

        console.log('Aggregation Result:', JSON.stringify(result, null, 2));

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
