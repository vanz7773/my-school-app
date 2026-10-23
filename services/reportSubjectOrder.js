const SUBJECT_ORDER = [
  ['englishlanguage', 'english'],
  ['mathematics', 'maths', 'math'],
  ['science', 'integratedscience', 'generalscience'],
  ['socialstudies'],
  ['religiousandmoraleducation', 'religiousmoraleducation', 'rme'],
  ['ghanaianlanguage', 'ghanaianlanguages', 'twi', 'asantetwi', 'akuapemtwi', 'ga', 'ewe', 'fante', 'dagbani', 'nzema', 'dagaare', 'kasem', 'gonja'],
  ['french'],
  ['computing', 'ict', 'informationandcommunicationtechnology'],
  ['careertechnology', 'basicdesignandtechnology', 'bdt'],
  ['creativeartsanddesign', 'creativearts'],
];

const normalizeSubject = value => String(value || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const getBasicLevel = className => {
  const name = String(className || '').toLowerCase();
  const basic = name.match(/\b(?:basic|bs|b|primary|class|grade)\s*[-.]?\s*([1-9])(?:\b|[a-z])/);
  if (basic) return Number(basic[1]);
  const jhs = name.match(/\b(?:jhs|jss|junior\s*high(?:\s*school)?)\s*[-.]?\s*([1-3])(?:\b|[a-z])/);
  return jhs ? Number(jhs[1]) + 6 : null;
};

function orderReportSubjects(subjects, className) {
  const level = getBasicLevel(className);
  if (!Array.isArray(subjects)) return [];
  if (level < 7 || level > 9 || level === null) return [...subjects];
  const ranked = subjects.map((subject, index) => {
    const name = normalizeSubject(subject.subject?.name || subject.subject?.subjectName || subject.name || subject.subjectName);
    let rank = SUBJECT_ORDER.findIndex(aliases => aliases.includes(name));
    if (rank < 0 && name.startsWith('ghanaianlanguage')) rank = 5;
    if (rank < 0 && /^(twi|ga|ewe|fante)language$/.test(name)) rank = 5;
    return { subject, index, rank: rank < 0 ? SUBJECT_ORDER.length : rank };
  });
  // Preserve every score and retain the original order of extra/unrecognized subjects.
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.subject);
}
module.exports = { orderReportSubjects, getBasicLevel };
