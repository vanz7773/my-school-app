const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderReportSubjects, getBasicLevel } = require('../services/reportSubjectOrder');
const names = ['English Language', 'Mathematics', 'Science', 'Social Studies', 'Religious and Moral Education (RME)', 'Ghanaian Language (Twi/Ga, etc.)', 'French', 'Computing', 'Career Technology', 'Creative Arts and Design'];

test('Basic 7-9 reports use the requested order without changing marks or input', () => {
  const subjects = names.map((name, index) => ({ subject: { name }, total: 50 + index, subjectRank: index + 1 })).reverse();
  const original = [...subjects];
  for (const className of ['Basic 7', 'Basic 8', 'Basic 9', 'BS7A', 'JHS 1', 'JHS 2', 'JHS 3']) {
    const sorted = orderReportSubjects(subjects, className);
    assert.deepEqual(sorted.map(item => item.subject.name), names);
    assert.equal(sorted[0].total, 50);
    assert.equal(sorted[9].subjectRank, 10);
  }
  assert.deepEqual(subjects, original);
});

test('common subject abbreviations sort correctly and additional subjects remain present', () => {
  const labels = ['Extra Subject B', 'Creative Arts', 'ICT', 'Twi', 'R.M.E.', 'Maths', 'English', 'Extra Subject A'];
  const subjects = labels.map(name => ({ subject: { name }, total: 80 }));
  const sorted = orderReportSubjects(subjects, 'Basic 8');
  assert.deepEqual(sorted.map(item => item.subject.name), ['English', 'Maths', 'R.M.E.', 'Twi', 'ICT', 'Creative Arts', 'Extra Subject B', 'Extra Subject A']);
  assert.equal(sorted.length, subjects.length);
});

test('unconfirmed primary order and nursery reports retain their existing order', () => {
  const subjects = [{ name: 'Maths' }, { name: 'English' }];
  for (const level of ['Basic 1', 'Basic 6', 'KG 2', 'Nursery', 'Unknown']) assert.deepEqual(orderReportSubjects(subjects, level), subjects);
  assert.equal(getBasicLevel('Junior High School 3'), 9);
});
