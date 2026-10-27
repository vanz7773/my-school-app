const ExcelJS = require('exceljs');

const text = value => value == null ? '' : String(value);

function buildStudentContactsWorkbook(students) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'School Management';
  const sheet = workbook.addWorksheet('Student Contacts', {
    views: [{ state: 'frozen', ySplit: 1, xSplit: 2, showGridLines: false }],
  });
  sheet.columns = [
    { header: 'Admission Number', key: 'admissionNumber', width: 22 },
    { header: 'Student Name', key: 'name', width: 34 },
    { header: 'Class', key: 'className', width: 22 },
    { header: 'Guardian Phone', key: 'guardianPhone', width: 24 },
    { header: 'Second Guardian Phone', key: 'guardianPhone2', width: 27 },
    { header: 'Academic Year', key: 'academicYear', width: 20 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Student ID', key: 'studentId', width: 30 },
  ];
  // Phone numbers and admission numbers are identifiers, including leading zeros.
  sheet.columns.forEach(column => {
    column.numFmt = '@';
    column.font = { name: 'Arial', size: 11, color: { argb: 'FF243247' } };
    column.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });

  const rows = students.map(student => ({
    admissionNumber: text(student.admissionNumber),
    name: text(student.user?.name || [student.surname, student.otherNames].filter(Boolean).join(' ')),
    className: text(student.class?.displayName || student.class?.name || 'Unassigned'),
    guardianPhone: text(student.guardianPhone),
    guardianPhone2: text(student.guardianPhone2),
    academicYear: text(student.academicYear),
    status: text(student.status),
    studentId: text(student._id),
  })).sort((a, b) => (
    a.className.localeCompare(b.className, 'en', { numeric: true }) ||
    a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId)
  ));

  rows.forEach(data => {
    const row = sheet.addRow(Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, value === '' ? null : value]),
    ));
    row.height = Math.max(24, Math.ceil(data.name.length / 32) * 16, Math.ceil(data.className.length / 20) * 16);
    for (const key of ['guardianPhone', 'guardianPhone2']) {
      row.getCell(key).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } };
    }
  });
  const header = sheet.getRow(1);
  header.height = 32;
  header.eachCell(cell => {
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263D5A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { right: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
  sheet.autoFilter = { from: 'A1', to: `H${sheet.rowCount}` };
  return workbook;
}

module.exports = { buildStudentContactsWorkbook };
