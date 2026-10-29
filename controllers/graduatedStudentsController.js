const Student = require('../models/Student');
const { groupGraduatedStudents } = require('../services/graduatedStudents');

exports.getGraduatedStudents = async (req, res) => {
  try {
    if (!req.user.school) return res.status(403).json({ message: 'School is required.' });
    const students = await Student.find({ school: req.user.school, status: 'graduated' })
      .select('user status surname otherNames admissionNumber gender dateOfBirth academicYear graduationAcademicYear dateOfLeaving profilePicture profilePictureThumbnail guardianName guardianPhone guardianPhone2 guardianOccupation fatherName fatherOccupation motherName motherOccupation religion hometown languageSpoken')
      .populate('user', 'name email').lean();
    const years = groupGraduatedStudents(students);
    res.json({ success: true, totalStudents: years.reduce((total, group) => total + group.count, 0), years });
  } catch (error) {
    console.error('Failed to load graduated students:', error.message);
    res.status(500).json({ message: 'Unable to load graduated students.' });
  }
};
