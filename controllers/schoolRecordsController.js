const SchoolRecord = require('../models/SchoolRecord');

// @desc    Get all school records for the logged-in school
// @route   GET /api/school-records
// @access  Private (Government/Basic Schools only)
exports.getRecords = async (req, res) => {
    try {
        const schoolId = req.user.school;
        const records = await SchoolRecord.find({ school: schoolId });
        res.status(200).json({ success: true, data: records });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Update or Create a school record for a specific class
// @route   POST /api/school-records/update
// @access  Private (Government/Basic Schools only)
exports.updateRecord = async (req, res) => {
    try {
        const { className, level, infrastructure, enrolment } = req.body;
        const schoolId = req.user.school;

        if (!className || !level) {
            return res.status(400).json({ success: false, message: 'Class name and level are required' });
        }

        // Upsert the record
        const record = await SchoolRecord.findOneAndUpdate(
            { school: schoolId, className },
            {
                school: schoolId,
                className,
                level,
                infrastructure,
                enrolment,
                updatedAt: Date.now()
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        // Force total calculation if not triggered by middleware (findOneAndUpdate bypasses save middleware usually, but let's check or handle it here)
        // Actually pre('save') is not called on findOneAndUpdate. We should calculate total here or use a helper.
        // Let's recalculate total manually to be safe.
        if (record.enrolment) {
            record.enrolment.total = (Number(record.enrolment.male) || 0) + (Number(record.enrolment.female) || 0);
            await record.save(); // This will trigger the pre-save hook and ensure consistency
        }

        res.status(200).json({ success: true, data: record });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
