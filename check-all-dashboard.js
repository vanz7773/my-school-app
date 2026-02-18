require('dotenv').config();
const mongoose = require('mongoose');
const Student = require('./models/Student');
const Class = require('./models/Class');
const School = require('./models/School');
const Grade = require('./models/Grade');
const Attendance = require('./models/StudentAttendance');
const Term = require('./models/term');

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        const school = await School.findOne({ schoolType: 'Government' });
        const targetSchool = school || await School.findOne();

        if (!targetSchool) {
            console.log('No schools found');
            process.exit(0);
        }

        console.log(`Checking data for school: ${targetSchool.name} (${targetSchool._id})`);

        // Get Active Term
        const today = new Date();
        const activeTerm = await Term.findOne({
            school: targetSchool._id,
        });
        const termId = activeTerm ? activeTerm._id : null;
        console.log(`Active Term ID: ${termId}`);

        // 1. Students By Class
        console.log('\n--- Students By Class ---');
        const studentResult = await Student.aggregate([
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
            }
        ]);
        console.log(`Result count: ${studentResult.length}`);

        // 2. Average Grades
        console.log('\n--- Average Grades ---');
        const gradeResult = await Grade.aggregate([
            {
                $lookup: {
                    from: 'classes',
                    localField: 'class',
                    foreignField: '_id',
                    as: 'classInfo'
                }
            },
            { $unwind: '$classInfo' },
            { $match: { 'classInfo.school': targetSchool._id } },
            {
                $group: {
                    _id: '$classInfo._id',
                    className: { $first: '$classInfo.name' },
                    average: { $avg: '$score' }
                }
            }
        ]);
        console.log(`Result count: ${gradeResult.length}`);

        // 3. Weekly Attendance
        console.log('\n--- Weekly Attendance ---');
        const attendanceMatch = {
            school: targetSchool._id,
            week: { $exists: true }
        };
        if (termId) {
            attendanceMatch.termId = termId; // This was the logic I saw in controller
            // Wait, does Attendance schema have termId?
        }

        const attendanceResult = await Attendance.aggregate([
            { $match: attendanceMatch },
            {
                $group: {
                    _id: { week: '$week', class: '$class' },
                    totalRecords: { $sum: 1 },
                    presentDays: {
                        $push: {
                            M: { $cond: [{ $eq: ['$days.M', 'present'] }, 1, 0] },
                            // ... simplified for test
                        }
                    }
                }
            }
        ]);
        console.log(`Result count: ${attendanceResult.length}`);


    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
};

run();
