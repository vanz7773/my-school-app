const School = require("../models/School");
const User = require("../models/User");
const Student = require("../models/Student");

// Helper error sender
const sendError = (res, code, message) =>
    res.status(code).json({ success: false, message });

exports.getAllSchools = async (req, res) => {
    try {
        // Basic pagination (optional, but good practice)
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100; // default large limit for now

        const skip = (page - 1) * limit;

        const schools = await School.find()
            .sort({ createdAt: -1 }) // newest first
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await School.countDocuments();

        // Enrich with stats if needed (students count, teachers count)
        // This could be slow if database is huge, but for now okay.
        // Parallelizing the count queries would be better.
        const enrichedSchools = await Promise.all(
            schools.map(async (school) => {
                const studentCount = await Student.countDocuments({ school: school._id });
                const teacherCount = await User.countDocuments({ school: school._id, role: "teacher" });
                const adminCount = await User.countDocuments({ school: school._id, role: "admin" });

                return {
                    ...school,
                    stats: {
                        students: studentCount,
                        teachers: teacherCount,
                        admins: adminCount
                    }
                };
            })
        );

        return res.json({
            success: true,
            count: total,
            schools: enrichedSchools,
            page,
            totalPages: Math.ceil(total / limit),
        });
    } catch (err) {
        console.error("Values error in getAllSchools:", err);
        return sendError(res, 500, "Server error fetching schools");
    }
};

exports.updateSchoolStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active' or 'restricted'

        if (!['active', 'restricted'].includes(status)) {
            return sendError(res, 400, "Invalid status. Use 'active' or 'restricted'");
        }

        const school = await School.findByIdAndUpdate(
            id,
            { status },
            { new: true }
        );

        if (!school) {
            return sendError(res, 404, "School not found");
        }

        return res.json({
            success: true,
            message: `School status updated to ${status}`,
            school
        });
    } catch (err) {
        console.error("Error in updateSchoolStatus:", err);
        return sendError(res, 500, "Server error updating status");
    }
};
