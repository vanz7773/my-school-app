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

test('nursery and unknown classes retain their existing order', () => {
  const subjects = [{ name: 'Maths' }, { name: 'English' }];
  for (const level of ['KG 2', 'Nursery', 'Unknown']) assert.deepEqual(orderReportSubjects(subjects, level), subjects);
  assert.equal(getBasicLevel('Junior High School 3'), 9);
});


test('Basic 4-6 reports use their separate nine-subject order and preserve scores', () => {
  const labels = ['English Language', 'Mathematics', 'Science', 'Ghanaian Language', 'French', 'Computing', 'History', 'Religious and Moral Education (RME)', 'Creative Arts'];
  const subjects = labels.map((name, index) => ({ subject: { name }, total: 60 + index })).reverse();
  const original = [...subjects];
  for (const className of ['Basic 4', 'Basic 5', 'Basic 6', 'Primary 4', 'BS6A']) {
    const sorted = orderReportSubjects(subjects, className);
    assert.deepEqual(sorted.map(item => item.subject.name), labels);
    sorted.forEach((item, index) => {
      assert.equal(item.total, 60 + index);
      assert.ok(subjects.includes(item));
    });
  }
  assert.deepEqual(subjects, original);
});

test('primary subject aliases use primary positions and retain extra subjects', () => {
  const labels = ['Extra B', 'R.M.E.', 'History of Ghana', 'ICT', 'Ga Language', 'French', 'Creative Arts', 'Extra A'];
  const sorted = orderReportSubjects(labels.map(name => ({ name })), 'Basic 5');
  assert.deepEqual(sorted.map(item => item.name), ['Ga Language', 'French', 'ICT', 'History of Ghana', 'R.M.E.', 'Creative Arts', 'Extra B', 'Extra A']);
});


test('Basic 1-3 reports use the seven-subject order without changing scores or input', () => {
  const labels = ['English Language', 'Mathematics', 'Science', 'Ghanaian Language (Twi/Ga)', 'History', 'Religious and Moral Education (RME)', 'Creative Arts'];
  const subjects = labels.map((name, index) => ({ subject: { name }, total: 70 + index })).reverse();
  const original = [...subjects];
  for (const className of ['Basic 1', 'Basic 2', 'Basic 3', 'Primary 1', 'BS3A']) {
    const sorted = orderReportSubjects(subjects, className);
    assert.deepEqual(sorted.map(item => item.subject.name), labels);
    sorted.forEach((item, index) => {
      assert.equal(item.total, 70 + index);
      assert.ok(subjects.includes(item));
    });
  }
  assert.deepEqual(subjects, original);
});

test('lower primary aliases sort correctly and retain additional subjects', () => {
  const subjects = ['Extra B', 'Creative Arts', 'R.M.E.', 'History of Ghana', 'Twi', 'Science', 'Maths', 'English', 'Extra A'].map(name => ({ name }));
  assert.deepEqual(orderReportSubjects(subjects, 'Basic 2').map(item => item.name), ['English', 'Maths', 'Science', 'Twi', 'History of Ghana', 'R.M.E.', 'Creative Arts', 'Extra B', 'Extra A']);
});
