const Student = require('../models/Student');
const { buildStudentContactsWorkbook } = require('../services/studentContactExport');
const { MAX_ROWS, ID_PATTERN, normalizePhone, parseStudentContacts, buildStudentContactsPreview } = require('../services/studentContactImport');

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

exports.previewStudentContacts = async (req, res) => {
  const school = req.user?.school?._id || req.user?.school;
  if (!school) return res.status(403).json({ message: 'A school is required to update student contacts.' });
  if (!req.file?.buffer) return res.status(400).json({ message: 'Choose an Excel spreadsheet to upload.' });
  let rows;
  try {
    rows = await parseStudentContacts(req.file.buffer);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  try {
    const ids = [...new Set(rows.map(row => row.studentId).filter(id => id && ID_PATTERN.test(id)))];
    const students = await Student.find({ school, _id: { $in: ids } })
      .select('_id user class guardianPhone guardianPhone2')
      .populate('user', 'name')
      .populate('class', 'name displayName')
      .lean();
    return res.json(buildStudentContactsPreview(rows, students));
  } catch (error) {
    console.error('Student contact preview failed:', error.message);
    return res.status(500).json({ message: 'Unable to preview student contacts. Please try again.' });
  }
};

exports.applyStudentContacts = async (req, res) => {
  const school = req.user?.school?._id || req.user?.school;
  if (!school) return res.status(403).json({ message: 'A school is required to update student contacts.' });
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
    return res.status(400).json({ message: `Provide between 1 and ${MAX_ROWS} reviewed changes.` });
  }

  // Validate the complete request before saving anything. Each row carries the
  // numbers seen in preview so a later edit cannot be silently overwritten.
  const seen = new Set();
  const validated = [];
  try {
    for (const row of rows) {
      const id = typeof row.studentId === 'string' ? row.studentId.toLowerCase() : '';
      if (!ID_PATTERN.test(id) || seen.has(id)) throw new Error('Invalid or duplicate student ID.');
      seen.add(id);
      if (!row.previous || !row.updates || typeof row.previous !== 'object' || typeof row.updates !== 'object' || Array.isArray(row.updates)) {
        throw new Error('The preview data is incomplete. Please preview the file again.');
      }
      const fields = Object.keys(row.updates);
      if (!fields.length || fields.some(field => !['guardianPhone', 'guardianPhone2'].includes(field))) {
        throw new Error('Only guardian phone numbers can be updated.');
      }
      for (const field of ['guardianPhone', 'guardianPhone2']) {
        if (typeof row.previous[field] !== 'string') throw new Error('The preview data is incomplete. Please preview the file again.');
      }
      const updates = {};
      for (const field of fields) {
        if (typeof row.updates[field] !== 'string' || !row.updates[field].trim()) throw new Error('Blank numbers cannot remove existing contacts.');
        updates[field] = normalizePhone(row.updates[field]);
      }
      validated.push({ id, row: row.row, previous: row.previous, updates });
    }
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  let saved = 0;
  const issues = [];
  for (const item of validated) {
    try {
      const query = { _id: item.id, school };
      for (const field of ['guardianPhone', 'guardianPhone2']) {
        query[field] = item.previous[field] === '' ? { $in: ['', null] } : item.previous[field];
      }
      const student = await Student.findOneAndUpdate(query, { $set: item.updates }, { new: true, runValidators: true }).select('_id').lean();
      if (student) saved++;
      else issues.push({ row: item.row, message: 'Student was removed or their contact changed since preview. Preview the file again.' });
    } catch (error) {
      console.error('Student contact update failed:', error.message);
      issues.push({ row: item.row, message: 'Could not save this student. Please try again.' });
    }
  }
  return res.json({ saved, issues, total: validated.length });
};
