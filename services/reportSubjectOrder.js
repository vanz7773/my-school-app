const JUNIOR_HIGH_ORDER = [
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

const UPPER_PRIMARY_ORDER = [
  ...JUNIOR_HIGH_ORDER.slice(0, 3),
  JUNIOR_HIGH_ORDER[5],
  JUNIOR_HIGH_ORDER[6],
  JUNIOR_HIGH_ORDER[7],
  ['history', 'historyofghana', 'ghanahistory'],
  JUNIOR_HIGH_ORDER[4],
  JUNIOR_HIGH_ORDER[9],
];

const LOWER_PRIMARY_ORDER = [
  ...JUNIOR_HIGH_ORDER.slice(0, 3),
  JUNIOR_HIGH_ORDER[5],
  UPPER_PRIMARY_ORDER[6],
  JUNIOR_HIGH_ORDER[4],
  JUNIOR_HIGH_ORDER[9],
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
  if (level === null || level < 1 || level > 9) return [...subjects];
  const subjectOrder = level <= 3 ? LOWER_PRIMARY_ORDER : level <= 6 ? UPPER_PRIMARY_ORDER : JUNIOR_HIGH_ORDER;
  const ranked = subjects.map((subject, index) => {
    let name = normalizeSubject(subject.subject?.name || subject.subject?.subjectName || subject.name || subject.subjectName);
    if (name.startsWith('ghanaianlanguage') || /^(twi|ga|ewe|fante)language$/.test(name)) name = 'ghanaianlanguage';
    const rank = subjectOrder.findIndex(aliases => aliases.includes(name));
    return { subject, index, rank: rank < 0 ? subjectOrder.length : rank };
  });
  // Preserve every score and retain the original order of extra/unrecognized subjects.
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.subject);
}
module.exports = { orderReportSubjects, getBasicLevel };
