const User = require('../models/User');
const Class = require('../models/Class');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');

/**
 * @desc    Global search for students, teachers, and classes
 * @route   GET /api/search
 * @access  Private
 */
exports.globalSearch = async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.trim() === '') {
            return res.status(400).json({ message: 'Search query is required' });
        }

        const schoolId = req.user.school;
        const regex = new RegExp(q, 'i'); // Case-insensitive search

        // 1. Find matching User IDs for Students and Teachers first
        // This allows us to search by name which is stored in the User model
        const [matchingStudentUsers, matchingTeacherUsers] = await Promise.all([
            User.find({
                school: schoolId,
                role: 'student',
                name: { $regex: regex }
            }).select('_id'),

            User.find({
                school: schoolId,
                role: 'teacher',
                name: { $regex: regex }
            }).select('_id')
        ]);

        const studentUserIds = matchingStudentUsers.map(u => u._id);
        const teacherUserIds = matchingTeacherUsers.map(u => u._id);

        // 2. Perform parallel searches on specific collections
        const [students, teachers, classes] = await Promise.all([
            // Search Students (by matched User ID OR admission number)
            Student.find({
                school: schoolId,
                $or: [
                    { user: { $in: studentUserIds } },
                    { admissionNumber: { $regex: regex } }
                ]
            })
                .populate('user', 'name profilePicture')
                .populate('class', 'name')
                .limit(5)
                .lean(),

            // Search Teachers (by matched User ID)
            Teacher.find({
                school: schoolId,
                user: { $in: teacherUserIds }
            })
                .populate('user', 'name email phone profilePicture')
                .populate('subjects', 'name')
                .limit(5)
                .lean(),

            // Search Classes (by name)
            Class.find({
                school: schoolId,
                name: { $regex: regex }
            })
                .select('name stream displayName teachers students')
                .populate('classTeacher', 'name')
                .limit(5)
                .lean()
        ]);

        // 3. Format results for frontend
        const formattedStudents = students.map(s => ({
            _id: s._id,
            name: s.user?.name || 'Unknown Student',
            admissionNumber: s.admissionNumber,
            class: s.class,
            profilePicture: s.user?.profilePicture
        }));

        const formattedTeachers = teachers.map(t => ({
            _id: t._id,
            name: t.user?.name || 'Unknown Teacher',
            email: t.user?.email,
            phone: t.phone || t.user?.phone,
            profilePicture: t.user?.profilePicture,
            subjects: t.subjects
        }));

        res.status(200).json({
            success: true,
            data: {
                students: formattedStudents,
                teachers: formattedTeachers,
                classes // Class schema structure typically matches frontend expectation directly
            }
        });

    } catch (error) {
        console.error('Search Error:', error);
        res.status(500).json({ message: 'Server error during search' });
    }
};
