const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

const MAX_ROWS = 5000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const ID_PATTERN = /^[a-f\d]{24}$/i;

function readCell(cell) {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  throw new Error('Use plain text or numbers, not formulas or other cell values.');
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Phone number contains invalid characters.');
  let number = raw.replace(/[\s().-]/g, '');
  if (/^[1-9]\d{8}$/.test(number)) number = `0${number}`;
  if (/^0+$/.test(number)) throw new Error('Enter a valid phone number.');
  if (/^0\d{9}$/.test(number)) return number;
  if (/^233\d{9}$/.test(number)) return `+${number}`;
  if (number.startsWith('+233') && !/^\+233\d{9}$/.test(number)) {
    throw new Error('Enter a complete Ghanaian phone number, such as +233241234567.');
  }
  if (/^\+[1-9]\d{7,14}$/.test(number)) return number;
  throw new Error('Enter a complete phone number, such as 0241234567 or +233241234567.');
}

async function parseStudentContacts(buffer) {
  let workbook;
  try {
    // Check the uncompressed size before asking ExcelJS to expand the archive.
    const entries = new AdmZip(buffer).getEntries();
    if (entries.length > 250 || entries.reduce((total, entry) => total + entry.header.size, 0) > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('The spreadsheet is too large to process.');
    }
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch (error) {
    if (error.message === 'The spreadsheet is too large to process.') throw error;
    throw new Error('Unable to read this Excel file. Please use the downloaded contacts spreadsheet.');
  }

  const sheet = workbook.getWorksheet('Student Contacts');
  if (!sheet) throw new Error('The workbook must contain the Student Contacts sheet.');
  if (sheet.rowCount > MAX_ROWS + 1) throw new Error(`The file can contain at most ${MAX_ROWS} student rows.`);
  if (sheet.columnCount > 100) throw new Error('The spreadsheet contains too many columns.');
  const headers = {};
  sheet.getRow(1).eachCell((cell, index) => {
    const name = readCell(cell).toLowerCase().replace(/\s+/g, ' ');
    if (name) {
      if (headers[name]) throw new Error(`Duplicate column: ${name}.`);
      headers[name] = index;
    }
  });
  for (const name of ['student id', 'guardian phone', 'second guardian phone']) {
    if (!headers[name]) throw new Error(`Missing column: ${name}. Please use the downloaded contacts spreadsheet.`);
  }

  const rows = [];
  for (let number = 2; number <= sheet.rowCount; number++) {
    const row = sheet.getRow(number);
    try {
      const studentId = readCell(row.getCell(headers['student id'])).toLowerCase();
      const guardianPhone = readCell(row.getCell(headers['guardian phone']));
      const guardianPhone2 = readCell(row.getCell(headers['second guardian phone']));
      const name = headers['student name'] ? readCell(row.getCell(headers['student name'])) : '';
      if (!studentId && !guardianPhone && !guardianPhone2 && !name) continue;
      rows.push({ row: number, studentId, name, guardianPhone, guardianPhone2 });
    } catch (error) {
      rows.push({ row: number, error: error.message });
    }
  }
  if (!rows.length) throw new Error('No student rows found in the spreadsheet.');
  return rows;
}

function buildStudentContactsPreview(rows, students) {
  const byId = new Map(students.map(student => [String(student._id).toLowerCase(), student]));
  const counts = new Map();
  rows.forEach(row => { if (row.studentId) counts.set(row.studentId, (counts.get(row.studentId) || 0) + 1); });
  const ready = [];
  const issues = [];
  let unchanged = 0;
  for (const row of rows) {
    const issue = message => issues.push({ row: row.row, name: row.name || '', message });
    if (row.error) { issue(row.error); continue; }
    if (!ID_PATTERN.test(row.studentId)) { issue('Student ID is missing or invalid.'); continue; }
    if (counts.get(row.studentId) > 1) { issue('Student ID appears more than once in the file.'); continue; }
    const student = byId.get(row.studentId);
    if (!student) { issue('Student was not found in your school.'); continue; }
    const previous = {
      guardianPhone: String(student.guardianPhone || ''),
      guardianPhone2: String(student.guardianPhone2 || ''),
    };
    const updates = {};
    try {
      for (const field of ['guardianPhone', 'guardianPhone2']) {
        // Empty cells never remove an existing number. Existing legacy values that
        // have not changed need not pass today's validation rules.
        if (!row[field] || row[field] === previous[field]) continue;
        const normalized = normalizePhone(row[field]);
        let oldNormalized = previous[field];
        try { oldNormalized = normalizePhone(previous[field]); } catch { /* Keep legacy value. */ }
        if (normalized !== oldNormalized) updates[field] = normalized;
      }
    } catch (error) { issue(error.message); continue; }
    if (!Object.keys(updates).length) { unchanged++; continue; }
    ready.push({
      row: row.row, studentId: row.studentId,
      name: student.user?.name || row.name || 'Student',
      className: student.class?.displayName || student.class?.name || 'Unassigned',
      previous, updates,
    });
  }
  return { ready, issues, unchanged, total: rows.length };
}

module.exports = { MAX_ROWS, ID_PATTERN, normalizePhone, parseStudentContacts, buildStudentContactsPreview };
