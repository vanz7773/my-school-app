// Older promotion runs stored the destination school year on graduates.
// Use its start year only as a labelled fallback, never today's date/updatedAt.
function getGraduationYear(student) {
  const completedYears = String(student.graduationAcademicYear || '').match(/\b\d{4}\b/g);
  if (completedYears?.length) return { year: completedYears[completedYears.length - 1], inferred: false };
  if (student.dateOfLeaving) {
    const date = new Date(student.dateOfLeaving);
    if (!Number.isNaN(date.getTime())) return { year: String(date.getUTCFullYear()), inferred: false };
  }
  const legacyYears = String(student.academicYear || '').match(/\b\d{4}\b/g);
  if (legacyYears?.length) return { year: legacyYears[0], inferred: true };
  return { year: 'Unknown', inferred: false };
}

function groupGraduatedStudents(students) {
  const grouped = new Map();
  for (const student of students) {
    if (student.status !== 'graduated') continue;
    const { year, inferred } = getGraduationYear(student);
    if (!grouped.has(year)) grouped.set(year, { year, students: [] });
    grouped.get(year).students.push({
      ...student, graduationYear: year, graduationYearInferred: inferred,
      name: student.user?.name || [student.surname, student.otherNames].filter(Boolean).join(' ') || 'Unnamed student',
      email: student.user?.email || '', currentClassName: 'Graduated'
    });
  }
  return [...grouped.values()].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    .map(group => ({ ...group, count: group.students.length,
      students: group.students.sort((a, b) => a.name.localeCompare(b.name)) }));
}
module.exports = { getGraduationYear, groupGraduatedStudents };
