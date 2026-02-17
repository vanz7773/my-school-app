const SchoolRecord = require('../models/SchoolRecord');

exports.getSchoolRecords = async (req, res) => {
    try {
        const schoolId = req.user.school;

        // Fetch all records for this school
        const records = await SchoolRecord.find({
            $or: [
                { school: schoolId },
                { 'school': schoolId }
            ]
        }).sort({ className: 1 }); // Sort by class name for consistency

        // Group records by level if needed on frontend, or just return flat list
        // The frontend can handle grouping
        return res.json(records);
    } catch (error) {
        console.error('Error fetching school records:', error);
        return res.status(500).json({ message: 'Error fetching school records', error: error.message });
    }
};

exports.updateSchoolRecord = async (req, res) => {
    try {
        const schoolId = req.user.school;
        const { className, level, infrastructure, enrolment } = req.body;

        if (!className || !level) {
            return res.status(400).json({ message: 'Class name and level are required' });
        }

        // Prepare update data
        const updateData = {
            school: schoolId,
            className,
            level,
            infrastructure: infrastructure || {},
            enrolment: enrolment || {},
            updatedAt: Date.now()
        };

        // Calculate total enrolment manually if not passed (though pre-save handles it too, upsert bypasses pre-save sometimes depending on method unless new:true with setDefaultsOnInsert)
        // Actually, findOneAndUpdate bypasses Mongoose middleware unless configured.
        // Let's calculate total here to be safe and explicit.
        if (enrolment) {
            updateData.enrolment.total = (Number(enrolment.male) || 0) + (Number(enrolment.female) || 0);
        }

        // Upsert: Find by school+className, update if exists, insert if not.
        const record = await SchoolRecord.findOneAndUpdate(
            { school: schoolId, className: className },
            updateData,
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        return res.json({ message: 'Record updated successfully', record });
    } catch (error) {
        console.error('Error updating school record:', error);
        return res.status(500).json({ message: 'Error updating school record', error: error.message });
    }
};
