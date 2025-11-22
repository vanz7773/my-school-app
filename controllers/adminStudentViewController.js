const Class = require('../models/Class');
const Student = require('../models/Student');

exports.getStudentsGroupedByClass = async (req, res) => {
  try {
    const schoolId = req.user.school;

    if (!schoolId) {
      return res.status(400).json({ message: 'School information missing in token.' });
    }

    const classes = await Class.find({ school: schoolId });

    const result = await Promise.all(
      classes.map(async (cls) => {
        const students = await Student.find({ class: cls._id })
          .populate('user', 'name');

        return {
          classId: cls._id,
          className: cls.name,
          students: students.map((s) => ({
            id: s._id,
            name: s.user?.name || 'Unnamed',
            admissionNumber: s.admissionNumber
          }))
        };
      })
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch student list', error: err.message });
  }
};
