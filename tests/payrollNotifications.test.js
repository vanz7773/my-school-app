const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const Staff = require('../models/PayrollStaff');
const User = require('../models/User');
const Notification = require('../models/Notification');
const sms = require('../services/smsService');
const pushes = require('../controllers/notificationController');
const controller = require('../controllers/payrollController');
const id = () => new mongoose.Types.ObjectId();
const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

function fixture(t, status = 'Approved') {
  const originals = [Payroll.findOneAndUpdate, Payroll.findOne, Payroll.updateOne, Teacher.findOne, Staff.findOne, User.findOne, Notification.findOneAndUpdate, sms.sendSms, pushes.sendPushNotifications];
  t.after(() => { [Payroll.findOneAndUpdate, Payroll.findOne, Payroll.updateOne, Teacher.findOne, Staff.findOne, User.findOne, Notification.findOneAndUpdate, sms.sendSms, pushes.sendPushNotifications] = originals; });
  const school = id(), userId = id(), events = [];
  const payroll = { _id: id(), school, status, month: '2026-10', payslips: [
    { _id: id(), teacher: id(), teacherName: 'Ama', contactPhone: '0241234567', netSalary: 900, grossSalary: 1000, totalDeductions: 100, referenceNumber: 'PAY-1' },
    { _id: id(), teacher: id(), teacherName: 'Cook', contactPhone: '0541234567', employeeModel: 'PayrollStaff', netSalary: 500, referenceNumber: 'PAY-2' },
  ] };
  Payroll.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.school, school);
    if (filter.status !== payroll.status) return null;
    Object.assign(payroll, update);
    return payroll;
  };
  Payroll.findOne = async filter => filter.status && filter.status !== payroll.status ? null : payroll;
  Payroll.updateOne = async (filter, update) => {
    const slipId = filter.payslips?.$elemMatch?._id || filter['payslips._id'];
    const slip = payroll.payslips.find(s => String(s._id) === String(slipId));
    for (const [key, value] of Object.entries(update.$set)) slip[key.replace('payslips.$.', '')] = value;
    return { modifiedCount: 1 };
  };
  Teacher.findOne = async filter => { assert.equal(filter.school, school); return { user: userId }; };
  Staff.findOne = async () => ({});
  User.findOne = filter => { assert.equal(filter.school, school); return { select: async () => ({ _id: userId, phone: '0241234567' }) }; };
  Notification.findOneAndUpdate = async (filter, update) => {
    const notification = new Notification({ _id: filter._id, ...(update.$set || update.$setOnInsert) });
    await notification.validate();
    assert.equal(notification.audience, 'specific');
    assert.equal(notification.type, 'salary-payment');
    assert.equal(notification.resourceModel, 'Payroll');
    assert.equal(String(notification.relatedResource), String(payroll._id));
    assert.deepEqual(notification.recipientUsers.map(String), [String(userId)]);
    events.push('in-app');
    return notification;
  };
  sms.sendSms = async args => { assert.match(args.message, /OCTOBER 2026 is paid/); events.push('sms'); };
  pushes.sendPushNotifications = async (users, title, message, data, options) => {
    assert.deepEqual(users, [userId]); assert.equal(options.throwOnError, true); assert.equal(options.mobileOnly, true);
    assert.equal(data.route, '/teacher/payslips'); assert.equal(data.recipientUserId, String(userId));
    assert.equal(data.payrollId, String(payroll._id)); events.push('push'); return { acceptedCount: 1 };
  };
  const req = { params: { id: payroll._id }, user: { school, _id: id() }, body: { status: 'Paid' } };
  return { payroll, events, req };
}

test('Mark as Paid sends SMS then teacher push, skips staff push, and repeated requests do not resend', async t => {
  const { payroll, events, req } = fixture(t);
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(response.statusCode, 200);
  assert.equal(payroll.status, 'Paid');
  assert.deepEqual(events, ['sms', 'in-app', 'push', 'sms']);
  assert.deepEqual(response.body.notifications.sms, { sent: 2, skipped: 0, failed: 0 });
  assert.deepEqual(response.body.notifications.push, { sent: 1, skipped: 1, failed: 0 });
  const paidAt = payroll.paidAt;
  const retry = res();
  await controller.updatePayrollStatus(req, retry);
  assert.equal(payroll.paidAt, paidAt);
  assert.equal(retry.body.notifications.sms.sent, 0);
  assert.equal(events.length, 4);
});

test('SMS failure preserves Paid status and still sends push; retry sends only missing SMS', async t => {
  const { payroll, req, events } = fixture(t);
  sms.sendSms = async () => { throw new Error('Insufficient SMS credits'); };
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(payroll.status, 'Paid');
  assert.equal(response.body.notifications.sms.failed, 2);
  assert.equal(response.body.notifications.push.sent, 1);
  assert.equal(response.body.notifications.inApp.sent, 1);
  assert.equal(payroll.payslips[0].salaryPaidSmsSending, false);
  sms.sendSms = async () => { events.push('sms'); };
  const retry = res();
  await controller.sendPaymentNotifications(req, retry);
  assert.equal(retry.body.notifications.sms.sent, 2);
  assert.equal(retry.body.notifications.push.sent, 0);
  assert.equal(events.filter(event => event === 'push').length, 1);
});

test('approval sends no payment notifications and payment retry endpoint rejects approved batches', async t => {
  const { events, req } = fixture(t, 'Draft');
  req.body.status = 'Approved';
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(response.body.payroll.status, 'Approved');
  assert.equal(events.length, 0);
  const retry = res();
  await controller.sendPaymentNotifications(req, retry);
  assert.equal(retry.statusCode, 400);
});

test('a previous approved salary SMS does not suppress the new payment SMS', async t => {
  const { payroll, req } = fixture(t);
  payroll.payslips[0].salarySmsSentAt = new Date(Date.now() - 60000);
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(response.body.notifications.sms.sent, 2);
});

test('push failure is reported without undoing payment or resending successful SMS', async t => {
  const { payroll, req, events } = fixture(t);
  pushes.sendPushNotifications = async () => { throw new Error('Push provider unavailable'); };
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(payroll.status, 'Paid');
  assert.equal(response.body.notifications.sms.sent, 2);
  assert.equal(response.body.notifications.push.failed, 1);
  assert.equal(response.body.notifications.inApp.sent, 1);
  assert.ok(payroll.payslips[0].salaryInAppSentAt);
  assert.equal(payroll.payslips[0].salaryPushSending, false);
  assert.equal(events.filter(event => event === 'sms').length, 2);
});

test('push helper reports provider acceptance and exposes failures to payroll retry tracking', async t => {
  const { Expo } = require('expo-server-sdk');
  const PushToken = require('../models/PushToken');
  const originals = [User.find, PushToken.find, Expo.prototype.sendPushNotificationsAsync];
  t.after(() => { [User.find, PushToken.find, Expo.prototype.sendPushNotificationsAsync] = originals; });
  User.find = () => ({ select() { return this; }, lean: async () => [{ pushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }] });
  PushToken.find = filter => filter.platform === 'web' ? [] : { select() { return this; }, lean: async () => [] };
  Expo.prototype.sendPushNotificationsAsync = async () => [{ status: 'ok', id: 'ticket1' }];
  const accepted = await pushes.sendPushNotifications([id()], 'Salary Paid', 'Payment confirmed', {}, { throwOnError: true });
  assert.equal(accepted.acceptedCount, 1);
  Expo.prototype.sendPushNotificationsAsync = async () => [{ status: 'error', message: 'DeviceNotRegistered' }];
  await assert.rejects(pushes.sendPushNotifications([id()], 'Salary Paid', 'Payment confirmed', {}, { throwOnError: true }), /Push provider rejected/);
});


test('previous manual payment SMS is not resent when payment notifications are retried', async t => {
  const { payroll, req } = fixture(t, 'Paid');
  payroll.paidAt = new Date(Date.now() - 60000);
  payroll.payslips[0].salarySmsSentAt = new Date();
  const response = res();
  await controller.sendPaymentNotifications(req, response);
  assert.equal(response.body.notifications.sms.sent, 1);
  assert.equal(response.body.notifications.sms.skipped, 1);
  assert.equal(response.body.notifications.push.sent, 1);
});

test('in-app failure is retried independently after mobile push and SMS have succeeded', async t => {
  const { payroll, req, events } = fixture(t);
  const saveNotification = Notification.findOneAndUpdate;
  Notification.findOneAndUpdate = async () => { throw new Error('Notification store unavailable'); };
  const response = res();
  await controller.updatePayrollStatus(req, response);
  assert.equal(response.body.notifications.sms.sent, 2);
  assert.equal(response.body.notifications.push.sent, 1);
  assert.equal(response.body.notifications.inApp.failed, 1);
  assert.equal(payroll.payslips[0].salaryInAppSending, false);
  Notification.findOneAndUpdate = saveNotification;
  const retry = res();
  await controller.sendPaymentNotifications(req, retry);
  assert.equal(retry.body.notifications.inApp.sent, 1);
  assert.equal(retry.body.notifications.sms.sent, 0);
  assert.equal(retry.body.notifications.push.sent, 0);
  assert.equal(events.filter(event => event === 'push').length, 1);
});

test('salary push mobile-only option does not query or send web push subscriptions', async t => {
  const PushToken = require('../models/PushToken');
  const originals = [User.find, PushToken.find];
  t.after(() => { [User.find, PushToken.find] = originals; });
  User.find = () => ({ select() { return this; }, lean: async () => [] });
  PushToken.find = filter => {
    assert.notEqual(filter.platform, 'web');
    return { select() { return this; }, lean: async () => [] };
  };
  const result = await pushes.sendPushNotifications([id()], 'Salary Paid', 'Payment confirmed', {}, { throwOnError: true, mobileOnly: true });
  assert.equal(result.acceptedCount, 0);
});
