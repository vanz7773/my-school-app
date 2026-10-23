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
  const batch = { _id: id(), school, status: 'Draft', month: '2026-10', payslips: [] };
  Payroll.findOne = async () => batch;
  try {
    let res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.statusCode, 400);
    batch.status = 'Paid';
    batch.payslips = [
      { _id: id(), salaryPaidSmsSentAt: new Date() },
      { _id: id(), teacher: id(), employeeModel: 'PayrollStaff', teacherName: 'Cook', contactPhone: '0241234567', grossSalary: 1000, totalDeductions: 100, netSalary: 900, referenceNumber: 'PAY-2026-10-ABCD' }
    ];
    Staff.findOne = async () => ({ phone: '0241234567' });
    const updates = [];
    Payroll.updateOne = async (filter, update) => { updates.push(update); return { modifiedCount: 1 }; };
    sms.sendSms = async args => { assert.match(args.message, /your salary for OCTOBER 2026 is paid/); assert.doesNotMatch(args.message, /Open the mobile app/); assert.match(args.message, /Net pay: GHS 900.00/); assert.equal(args.schoolId, school); };
    res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.body.sent, 1); assert.equal(res.body.skipped, 1);
    assert.ok(updates[1].$set['payslips.$.salaryPaidSmsSentAt']);
    const originalTeacherFind = Teacher.findOne;
    try {
      batch.payslips[1].employeeModel = 'Teacher';
      Teacher.findOne = async () => ({ phone: '0241234567' });
      sms.sendSms = async args => { assert.match(args.message, /Open the mobile app to view your payslip\./); };
      res = response();
      await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
      assert.equal(res.body.sent, 1);
    } finally { Teacher.findOne = originalTeacherFind; batch.payslips[1].employeeModel = 'PayrollStaff'; }
    sms.sendSms = async () => { throw new Error('SMS disabled'); };
    res = response();
    await controller.sendSalarySms({ params: { id: batch._id }, user: { school } }, res);
    assert.equal(res.body.failed, 1);
    assert.equal(updates.at(-1).$set['payslips.$.salaryPaidSmsSending'], false);
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

test('salary save persists numeric components for teachers and non-teaching staff with formatted phones', async () => {
  const originals = [Teacher.findOne, Staff.findOne, Salary.findOneAndUpdate];
  const school = id(), employeeId = id();
  Teacher.findOne = Staff.findOne = async filter => {
    assert.equal(filter.school, school);
    return { _id: employeeId };
  };
  let persisted;
  Salary.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(filter.school, school);
    assert.equal(filter.teacher, employeeId);
    assert.equal(options.runValidators, true);
    const doc = new Salary({ ...filter, ...update });
    await doc.validate();
    persisted = doc.toObject();
    return doc;
  };
  try {
    for (const employeeModel of ['Teacher', 'PayrollStaff']) {
      for (const phone of ['024 123 4567', '+233 24 123 4567', '024-123-4567', '00233241234567', '241234567']) {
        const res = response();
        await controller.updateTeacherSalary({ user: { school }, body: {
          teacherId: employeeId, employeeModel, baseSalary: '1250.75',
          allowances: [{ name: 'Transport', amount: '50.25' }],
          deductions: [{ name: 'SSNIT', amount: '20' }], contactPhone: phone,
          accountDetails: { bankName: 'Bank', accountNumber: '0012345' }
        } }, res);
        assert.equal(res.statusCode, 200, res.body?.message);
        assert.equal(persisted.baseSalary, 1250.75);
        assert.equal(persisted.allowances[0].amount, 50.25);
        assert.equal(persisted.deductions[0].amount, 20);
        assert.equal(persisted.contactPhone, '233241234567');
        assert.equal(persisted.employeeModel, employeeModel);
      }
    }
    const res = response();
    await controller.updateTeacherSalary({ user: { school }, body: {
      teacherId: employeeId, baseSalary: 0, allowances: [], deductions: [], contactPhone: 'invalid'
    } }, res);
    assert.equal(res.statusCode, 400);
  } finally { [Teacher.findOne, Staff.findOne, Salary.findOneAndUpdate] = originals; }
});

test('concurrent first salary saves recover the duplicate insert within the same school', async () => {
  const originals = [Teacher.findOne, Salary.findOneAndUpdate];
  const school = id(), teacherId = id();
  Teacher.findOne = async () => ({ _id: teacherId });
  let calls = 0;
  Salary.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(filter.school, school);
    assert.equal(filter.teacher, teacherId);
    calls++;
    if (calls === 1) {
      assert.equal(options.upsert, true);
      throw Object.assign(new Error('Duplicate teacher'), { code: 11000, keyPattern: { teacher: 1 } });
    }
    assert.equal(options.upsert, undefined);
    return new Salary({ ...filter, ...update });
  };
  try {
    const res = response();
    await controller.updateTeacherSalary({ user: { school }, body: { teacherId, baseSalary: 1500, allowances: [], deductions: [] } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.salary.baseSalary, 1500);
    assert.equal(calls, 2);
  } finally { [Teacher.findOne, Salary.findOneAndUpdate] = originals; }
});
