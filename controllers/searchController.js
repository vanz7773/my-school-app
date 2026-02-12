const User = require('../models/User');
const Class = require('../models/Class');

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

        // perform parallel searches for better performance
        const [students, teachers, classes] = await Promise.all([
            // Search Students
            User.find({
                school: schoolId,
                role: 'student',
                name: { $regex: regex }
            })
                .select('name profilePicture role admissionNumber class')
                .populate('class', 'name')
                .limit(5),

            // Search Teachers
            User.find({
                school: schoolId,
                role: 'teacher',
                name: { $regex: regex }
            })
                .select('name profilePicture role email phone')
                .limit(5),

            // Search Classes
            Class.find({
                school: schoolId,
                name: { $regex: regex }
            })
                .select('name stream displayName teachers students')
                .populate('classTeacher', 'name')
                .limit(5)
        ]);

        res.status(200).json({
            success: true,
            data: {
                students,
                teachers,
                classes
            }
        });

    } catch (error) {
        console.error('Search Error:', error);
        res.status(500).json({ message: 'Server error during search' });
    }
};
