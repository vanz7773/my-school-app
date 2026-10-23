const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Teacher = require('../models/Teacher');
const Staff = require('../models/PayrollStaff');
const Salary = require('../models/TeacherSalary');
const Payroll = require('../models/Payroll');
const sms = require('../services/smsService');
const controller = require('../controllers/payrollController');
const id = () => new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('dynamic payroll references resolve teachers and payroll-only staff', async () => {
  const teacherId = id(), staffId = id();
  const originals = [Teacher.find, Staff.find];
  Teacher.find = () => ({ exec: async () => [new Teacher({ _id: teacherId, school: id(), user: id() })] });
  Staff.find = () => ({ exec: async () => [new Staff({ _id: staffId, school: id(), name: 'Cook', phone: '0241234567' })] });
  try {
    const salary = new Salary({ school: id(), teacher: staffId, employeeModel: 'PayrollStaff' });
    await salary.populate('teacher');
    assert.equal(salary.teacher.name, 'Cook');
    const batch = new Payroll({ school: id(), month: '2026-10', payslips: [
      { teacher: teacherId }, { teacher: staffId, employeeModel: 'PayrollStaff' }
    ] });
    await batch.populate('payslips.teacher');
    assert.equal(batch.payslips[0].teacher.constructor.modelName, 'Teacher');
    assert.equal(batch.payslips[1].teacher.name, 'Cook');
  } finally { [Teacher.find, Staff.find] = originals; }
});

test('salary SMS rejects drafts, skips sent slips, and releases failed claims', async () => {
  const originals = [Payroll.findOne, Payroll.updateOne, Staff.findOne, sms.sendSms];
  const school = id();
  const batch = { _id: id(), status: 'Draft', month: '2026-10', payslips: [] };
  Payroll.findOne = async () => batch;
  try {
    let res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.statusCode, 400);
    batch.status = 'Paid';
    batch.payslips = [
      { _id: id(), salarySmsSentAt: new Date() },
      { _id: id(), teacher: id(), employeeModel: 'PayrollStaff', teacherName: 'Cook', contactPhone: '0241234567', grossSalary: 1000, totalDeductions: 100, netSalary: 900, referenceNumber: 'PAY-2026-10-ABCD' }
    ];
    Staff.findOne = async () => ({ phone: '0241234567' });
    const updates = [];
    Payroll.updateOne = async (filter, update) => { updates.push(update); return { modifiedCount: 1 }; };
    sms.sendSms = async args => { assert.match(args.message, /Net pay: GHS 900.00/); assert.equal(args.schoolId, school); };
    res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.body.sent, 1); assert.equal(res.body.skipped, 1);
    assert.ok(updates[1].$set['payslips.$.salarySmsSentAt']);
    sms.sendSms = async () => { throw new Error('SMS disabled'); };
    res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.body.failed, 1);
    assert.equal(updates.at(-1).$set['payslips.$.salarySmsSending'], false);
  } finally { [Payroll.findOne, Payroll.updateOne, Staff.findOne, sms.sendSms] = originals; }
});

test('salary assignments cannot target an employee outside the current school', async () => {
  const original = Staff.findOne;
  const school = id(), employee = id();
  Staff.findOne = async filter => {
    assert.equal(filter.school, school);
    assert.equal(filter._id, employee);
    return null;
  };
  try {
    const res = response();
    await controller.updateTeacherSalary({ user: { school }, body: { teacherId: employee, employeeModel: 'PayrollStaff', baseSalary: 1000 } }, res);
    assert.equal(res.statusCode, 404);
  } finally { Staff.findOne = original; }
});
