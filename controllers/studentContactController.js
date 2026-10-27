const Student = require('../models/Student');
const { buildStudentContactsWorkbook } = require('../services/studentContactExport');

exports.downloadStudentContacts = async (req, res) => {
  const school = req.user?.school?._id || req.user?.school;
  if (!school) return res.status(403).json({ message: 'A school is required to export student contacts.' });

  try {
    // Always export the entire authenticated school, independent of table filters/pages.
    const students = await Student.find({ school })
      .select('_id user surname otherNames admissionNumber class guardianPhone guardianPhone2 academicYear status')
      .populate('user', 'name')
      .populate('class', 'name displayName')
      .lean();
    if (!students.length) return res.status(404).json({ message: 'No students found for this school.' });

    const workbook = buildStudentContactsWorkbook(students);
    const buffer = await workbook.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="student-contacts-whole-school-${date}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Student contact export failed:', error.message);
    return res.status(500).json({ message: 'Unable to export student contacts. Please try again.' });
  }
};
