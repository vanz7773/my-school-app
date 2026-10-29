const { test } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const Student = require('../models/Student');
const sms = require('../services/smsService');
const { collectParentPhonesFromStudents: collect, collectAnnouncementPhones, sendReportSms } = require('../services/studentSmsRecipients');

function setup(t) {
  const sent = [];
  t.mock.method(User, 'find', () => { throw new Error('Unexpected user lookup'); });
  t.mock.method(Student, 'find', () => { throw new Error('Unexpected student lookup'); });
  t.mock.method(sms, 'getSchoolSettings', async () => ({ smsEnabled: true, autoTriggers: { examReports: true } }));
  t.mock.method(sms, 'sendSms', async args => { sent.push(args); return { sentCount: args.recipients.length }; });
  return sent;
}

test('guardian-only students receive both valid numbers without account lookup', async t => {
  setup(t);
  assert.deepEqual(await collect([{ guardianPhone: '0243152631', guardianPhone2: '0548554449' }], 'school-a'), ['233243152631', '233548554449']);
});

test('normalizes duplicate contacts and ignores missing, invalid and other-school records', async t => {
  setup(t);
  assert.deepEqual(await collect([null, { guardianPhone: '054679092' }, { school: 'school-b', guardianPhone: '0548554449' }, { guardianPhone: '0243152631', guardianPhone2: '+233243152631' }], 'school-a'), ['233243152631']);
  await assert.rejects(collect([], null), /School is required/);
});

test('combines legacy and multiple parent links using a school-scoped parent lookup', async t => {
  setup(t);
  User.find.mock.mockImplementation(filter => {
    assert.deepEqual(filter, { _id: { $in: ['parent-a', 'parent-b'] }, school: 'school-a', role: 'parent' });
    return { select: async () => [{ phone: '+233243152631' }, { phone: '0548554449' }] };
  });
  assert.deepEqual(await collect([{ guardianPhone: '0243152631', parent: { _id: 'parent-a' }, parentIds: [null, 'parent-a', 'parent-b'] }], 'school-a'), ['233243152631', '233548554449']);
});

test('class announcement includes guardian-only students within the selected school and class', async t => {
  setup(t);
  Student.find.mock.mockImplementation(filter => {
    assert.deepEqual(filter, { school: 'school-a', status: { $ne: 'withdrawn' }, class: 'class-a' });
    return { select: async () => [{ guardianPhone: '0243152631' }] };
  });
  assert.deepEqual(await collectAnnouncementPhones({ schoolId: 'school-a', classId: 'class-a', includeGuardians: true }), ['233243152631']);
});

test('staff-only announcement does not query guardian contacts', async t => {
  setup(t);
  User.find.mock.mockImplementation(filter => {
    assert.equal(filter.school, 'school-a');
    return { select: async () => [{ phone: '0548554449' }] };
  });
  assert.deepEqual(await collectAnnouncementPhones({ schoolId: 'school-a', recipientUserIds: ['teacher-a'], includeGuardians: false }), ['233548554449']);
});

test('report alert reaches guardians without a user account or parent link', async t => {
  const sent = setup(t);
  await sendReportSms({ schoolId: 'school-a', termLabel: 'Term 1', students: [{ name: 'Irene', guardianPhone: '0243152631' }] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].recipients, ['233243152631']);
  assert.match(sent[0].message, /Term 1 report card for Irene/);
});

test('report alert deduplicates student, parent and guardian phones', async t => {
  const sent = setup(t);
  User.find.mock.mockImplementation(filter => {
    assert.equal(filter.school, 'school-a');
    assert.ok(['parent', 'student'].includes(filter.role));
    return { select: async () => [{ phone: '+233243152631' }] };
  });
  await sendReportSms({ schoolId: 'school-a', termLabel: 'Term 1', students: [{ guardianPhone: '0243152631', parent: 'parent-a', user: { _id: 'student-a', name: 'Irene' } }] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].recipients, ['233243152631']);
});

test('disabled report trigger does not resolve or send recipients', async t => {
  const sent = setup(t);
  sms.getSchoolSettings.mock.mockImplementation(async () => ({ smsEnabled: true, autoTriggers: { examReports: false } }));
  await sendReportSms({ schoolId: 'school-a', students: [{ parent: 'parent-a' }] });
  assert.equal(sent.length, 0);
});

test('enabled fee payment receipt reaches a guardian without a registered parent', async t => {
  const sent = setup(t);
  sms.getSchoolSettings.mock.mockImplementation(async () => ({ smsEnabled: true, autoTriggers: { feePayments: true } }));
  const { sendFeePaymentSms } = require('../services/studentSmsRecipients');
  await sendFeePaymentSms({ schoolId: 'school-a', student: { guardianPhone: '0243152631' }, message: 'Payment received. Balance: GHS 20.' });
  assert.deepEqual(sent, [{ schoolId: 'school-a', recipients: ['233243152631'], message: 'Payment received. Balance: GHS 20.', messageType: 'fees' }]);
});

test('fee receipts respect the SMS switch, trigger and daily-variable exception', async t => {
  const sent = setup(t);
  const { sendFeePaymentSms } = require('../services/studentSmsRecipients');
  for (const settings of [{ smsEnabled: false, autoTriggers: { feePayments: true } }, { smsEnabled: true, autoTriggers: { feePayments: false } }]) {
    sms.getSchoolSettings.mock.mockImplementation(async () => settings);
    await sendFeePaymentSms({ schoolId: 'school-a', student: { parent: 'parent-a' }, message: 'Receipt' });
  }
  sms.getSchoolSettings.mock.mockImplementation(async () => { throw new Error('Daily payments must skip immediate SMS'); });
  await sendFeePaymentSms({ schoolId: 'school-a', student: { parent: 'parent-a' }, isDailyVariable: true });
  assert.equal(sent.length, 0);
});
